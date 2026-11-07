// 파일 유틸 — 원자적 쓰기(tmp → rename)와 Windows rename 재시도.
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

/** Windows에서 백신·인덱서·VS Code 파일 감시가 잠깐 파일을 잡으면 rename이 EPERM/EBUSY/EACCES로 실패해요. */
export const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException | undefined)?.code ?? '';
}

export interface RenameRetryOptions {
  retries?: number;
  delayMs?: number;
  rename?: (from: string, to: string) => Promise<void>;
}

export async function renameWithRetry(from: string, to: string, opts: RenameRetryOptions = {}): Promise<void> {
  const retries = opts.retries ?? 8;
  const delay = opts.delayMs ?? 50;
  const rename = opts.rename ?? ((a: string, b: string) => fsp.rename(a, b));
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (!RETRYABLE_RENAME_CODES.has(errCode(e)) || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
    }
  }
}

let tmpSeq = 0;

/** 같은 폴더의 임시 파일에 쓰고 fsync → rename. 실패하면 임시 파일을 지워요. */
export async function atomicWriteFile(file: string, text: string, opts: RenameRetryOptions = {}): Promise<void> {
  await fsp.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  const h = await fsp.open(tmp, 'w');
  try {
    await h.writeFile(text, 'utf8');
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await renameWithRetry(tmp, file, opts);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export function timestampForFile(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}
