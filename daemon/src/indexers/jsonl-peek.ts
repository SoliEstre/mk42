// 큰 JSONL을 통째로 읽지 않고 앞·뒤만 읽어요 (512MB 넘는 Claude 세션 파일이 있어요).
// 줄 경계는 바이트(0x0A)로 자르고 줄마다 UTF-8로 풀어서 청크 경계에서 글자가 깨지지 않아요.
import { open, type FileHandle } from 'node:fs/promises';

export interface PeekOptions {
  /** 앞쪽 첫 읽기 크기 (기본 64KB) */
  headBytes?: number;
  /** 뒤쪽 첫 읽기 크기 (기본 64KB) */
  tailBytes?: number;
  /** headUntil이 아직 false면 앞쪽을 이 크기까지 더 읽어요 (기본 4MB) */
  maxHeadBytes?: number;
  /** 뒤쪽에서 레코드를 하나도 못 찾으면 이 크기까지 넓혀요 (기본 1MB) */
  maxTailBytes?: number;
  /** 이보다 긴 줄은 건너뛰어요 (기본 1MB) */
  maxLineBytes?: number;
  /** 앞쪽 레코드를 받을 때마다 호출 — true를 돌려주면 앞쪽 확장 읽기를 멈춰요 */
  headUntil?: (rec: unknown) => boolean;
  /** 뒤쪽 레코드가 충분한지 — false면 maxTailBytes까지 창을 넓혀요 (기본: 레코드가 하나라도 있으면 충분) */
  tailUntil?: (recs: unknown[]) => boolean;
}

export interface PeekResult {
  /** 파일 앞쪽 레코드 (순서대로) */
  head: unknown[];
  /** 파일 뒤쪽 레코드 (순서대로). whole이면 비어 있어요 */
  tail: unknown[];
  /** 파일이 작아서 전체를 head에 담았는지 */
  whole: boolean;
  size: number;
}

const KB = 1024;

function parseLine(buf: Buffer): unknown {
  if (buf.length === 0) return undefined;
  const text = buf.toString('utf8').trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 버퍼를 줄로 나눠 파싱해요. dropFirst면 첫 조각(앞이 잘린 줄)을, dropLast면 마지막 조각(뒤가 잘린 줄)을 버려요. */
function parseChunk(buf: Buffer, dropFirst: boolean, dropLast: boolean): unknown[] {
  const out: unknown[] = [];
  let start = 0;
  let first = true;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) break;
    if (!(first && dropFirst)) {
      const rec = parseLine(buf.subarray(start, nl));
      if (rec !== undefined) out.push(rec);
    }
    first = false;
    start = nl + 1;
  }
  if (start < buf.length && !dropLast && !(first && dropFirst)) {
    const rec = parseLine(buf.subarray(start));
    if (rec !== undefined) out.push(rec);
  }
  return out;
}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

type ScanOptions = Required<Omit<PeekOptions, 'headUntil' | 'tailUntil'>> & Pick<PeekOptions, 'headUntil'>;

async function scanHead(fh: FileHandle, size: number, o: ScanOptions): Promise<unknown[]> {
  const out: unknown[] = [];
  const limit = Math.min(size, o.maxHeadBytes);
  let pos = 0;
  let carry: Buffer[] = [];
  let carryLen = 0;
  let skipping = false;
  let satisfied = false;
  const push = (rec: unknown) => {
    out.push(rec);
    if (!satisfied && o.headUntil?.(rec)) satisfied = true;
  };
  while (pos < limit) {
    // 첫 창(headBytes)은 항상 끝까지 읽고, 그 뒤로는 headUntil이 만족되지 않았을 때만 더 읽어요.
    if (pos >= o.headBytes && (satisfied || !o.headUntil)) break;
    const len = Math.min(o.headBytes, limit - pos);
    const chunk = await readAt(fh, pos, len);
    if (chunk.length === 0) break;
    pos += chunk.length;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      if (skipping) {
        skipping = false;
      } else {
        const piece = chunk.subarray(start, nl);
        const line = carryLen > 0 ? Buffer.concat([...carry, piece]) : piece;
        const rec = parseLine(line);
        if (rec !== undefined) push(rec);
      }
      carry = [];
      carryLen = 0;
      start = nl + 1;
    }
    if (start < chunk.length && !skipping) {
      const rest = chunk.subarray(start);
      carry.push(Buffer.from(rest));
      carryLen += rest.length;
      if (carryLen > o.maxLineBytes) {
        carry = [];
        carryLen = 0;
        skipping = true;
      }
    }
  }
  // 파일 끝까지 읽었으면 마지막 줄(개행 없음)도 레코드예요.
  if (pos >= size && carryLen > 0 && !skipping) {
    const rec = parseLine(Buffer.concat(carry));
    if (rec !== undefined) push(rec);
  }
  return out;
}

export async function peekJsonl(filePath: string, opts: PeekOptions = {}): Promise<PeekResult> {
  const o = {
    headBytes: opts.headBytes ?? 64 * KB,
    tailBytes: opts.tailBytes ?? 64 * KB,
    maxHeadBytes: Math.max(opts.maxHeadBytes ?? 4096 * KB, opts.headBytes ?? 64 * KB),
    maxTailBytes: Math.max(opts.maxTailBytes ?? 1024 * KB, opts.tailBytes ?? 64 * KB),
    maxLineBytes: opts.maxLineBytes ?? 1024 * KB,
    headUntil: opts.headUntil,
  };
  const tailEnough = opts.tailUntil ?? ((recs: unknown[]) => recs.length > 0);
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= o.headBytes + o.tailBytes) {
      const all = await readAt(fh, 0, size);
      return { head: parseChunk(all, false, false), tail: [], whole: true, size };
    }
    const head = await scanHead(fh, size, o);
    let tail: unknown[] = [];
    for (let win = o.tailBytes; ; win = Math.min(win * 4, o.maxTailBytes)) {
      const start = Math.max(0, size - win);
      const buf = await readAt(fh, start, size - start);
      tail = parseChunk(buf, start > 0, false);
      if (win >= o.maxTailBytes || start === 0 || tailEnough(tail)) break;
    }
    return { head, tail, whole: false, size };
  } finally {
    await fh.close();
  }
}
