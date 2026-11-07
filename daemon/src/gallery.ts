// 확장 갤러리(Open VSX — Mk42의 갤러리)에서 에이전트 확장의 최신 정식판을 확인하고 VSIX를 받아요.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** 받은 바이트 진행을 알릴 때만 써요(fetch의 Response) — 없으면 arrayBuffer로 한 번에 */
  headers?: { get(name: string): string | null };
  body?: AsyncIterable<Uint8Array> | null;
}>;

/** 받은 바이트·전체 바이트(Content-Length가 없으면 undefined) */
export type DownloadProgressFn = (received: number, total: number | undefined) => void;

/** 응답 본문 — onProgress가 있고 본문을 흘려 읽을 수 있으면 조각마다(250ms 간격) 알려요 */
export async function readBody(r: Awaited<ReturnType<FetchFn>>, onProgress?: DownloadProgressFn): Promise<Buffer> {
  if (!onProgress || !r.body) return Buffer.from(await r.arrayBuffer());
  const total = Number(r.headers?.get('content-length') ?? '') || undefined;
  const chunks: Buffer[] = [];
  let received = 0;
  let last = 0;
  onProgress(0, total);
  for await (const chunk of r.body) {
    chunks.push(Buffer.from(chunk));
    received += chunk.length;
    if (received > MAX_VSIX_BYTES) throw new Error(`download larger than ${MAX_VSIX_BYTES} bytes`);
    const now = Date.now();
    if (now - last >= 250) {
      last = now;
      onProgress(received, total);
    }
  }
  onProgress(received, total);
  return Buffer.concat(chunks, received);
}

/** 받는 VSIX 크기 상한(Codex VSIX는 약 600MB) */
export const MAX_VSIX_BYTES = 2 * 1024 * 1024 * 1024;

export const ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;
export const VERSION = /^\d+\.\d+\.\d+$/;
export const PLATFORM = /^[a-z0-9-]+$/;

/**
 * `engines.vscode` 범위(`^1.96.2`·`>=1.90.0`·`1.95.x`·`*`)가 앱 버전을 받는지 — VS Code처럼 최소 버전만 봐요(`^`도 «이상»).
 * 읽을 수 없는 범위는 받는 것으로 쳐요(설치가 최종 판단).
 */
export function engineAccepts(range: string, appVersion: string): boolean {
  const min = /(\d+)\.(\d+|x)(?:\.(\d+|x))?/.exec(range);
  const app = /^(\d+)\.(\d+)\.(\d+)/.exec(appVersion);
  if (!min || !app) return true;
  const want = [Number(min[1]), min[2] === 'x' ? 0 : Number(min[2]), min[3] === undefined || min[3] === 'x' ? 0 : Number(min[3])];
  const have = [Number(app[1]), Number(app[2]), Number(app[3])];
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!;
  }
  return true;
}

export const OPEN_VSX_API_URL = 'https://open-vsx.org/api';

/**
 * Open VSX(Mk42 갤러리)에서 그 플랫폼의 최신 정식판 — `GET /api/<ns>/<name>/<platform>`. 최신이 시험판이면 undefined(새 정식판 없음 —
 * Mk42 자동 업데이트에 맡겨요).
 */
export async function latestOpenVsxVersion(
  id: string,
  targetPlatform: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  engineVersion?: string,
): Promise<string | undefined> {
  if (!ID.test(id) || !PLATFORM.test(targetPlatform)) throw new Error(`bad extension id or platform: ${id} ${targetPlatform}`);
  const [ns, name] = id.split('.') as [string, string];
  const r = await fetchFn(`${OPEN_VSX_API_URL}/${ns}/${name}/${targetPlatform}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`open vsx ${id}: HTTP ${r.status}`);
  const j = (await r.json()) as { version?: unknown; preRelease?: unknown; engines?: { vscode?: unknown } };
  if (typeof j.version !== 'string' || !VERSION.test(j.version)) throw new Error(`open vsx ${id}: no version`);
  if (j.preRelease === true) return undefined;
  // 앱보다 새 엔진을 요구하는 판은 깔 수 없어요 — 받지 않아요(수백 MB를 받아 시험 설치에서 실패하지 않게)
  const engine = j.engines?.vscode;
  if (engineVersion && typeof engine === 'string' && !engineAccepts(engine, engineVersion)) return undefined;
  return j.version;
}

/**
 * Open VSX에서 그 버전·플랫폼의 VSIX를 `<dir>\openvsx-<id>-<버전>-<플랫폼>.vsix`로 받아요(검증 전 후보). 임시 파일에 받아 ZIP인지
 * 확인한 뒤 이름을 바꿔요. 받은 주소는 API가 준 files.download — open-vsx.org가 아니면 받지 않아요.
 */
export async function downloadOpenVsxVsix(
  id: string,
  version: string,
  targetPlatform: string,
  dir: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  onProgress?: DownloadProgressFn,
): Promise<string> {
  if (!ID.test(id) || !VERSION.test(version) || !PLATFORM.test(targetPlatform)) throw new Error(`bad vsix ref: ${id} ${version} ${targetPlatform}`);
  const [ns, name] = id.split('.') as [string, string];
  const meta = await fetchFn(`${OPEN_VSX_API_URL}/${ns}/${name}/${targetPlatform}/${version}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!meta.ok) throw new Error(`open vsx ${id} ${version}: HTTP ${meta.status}`);
  const url = ((await meta.json()) as { files?: { download?: unknown } }).files?.download;
  if (typeof url !== 'string' || !/^https:\/\/open-vsx\.org\//i.test(url)) throw new Error(`open vsx ${id} ${version}: no download url`);
  const file = join(dir, `openvsx-${id}-${version}-${targetPlatform}.vsix`);
  await fsp.mkdir(dir, { recursive: true });
  const r = await fetchFn(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!r.ok) throw new Error(`download ${id} ${version} (open vsx): HTTP ${r.status}`);
  const buf = await readBody(r, onProgress);
  if (buf.length < 4 || buf.length > MAX_VSIX_BYTES || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`download ${id} ${version} (open vsx): not a VSIX (${buf.length} bytes)`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, file);
  return file;
}
