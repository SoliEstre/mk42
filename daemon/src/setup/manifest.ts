// Mk42 설치 패키지 목록(manifest.json)과 구성 요소 트리 해시. 패키지 생성기(build/scripts/package.mjs)와 설치 엔진이 같이 써요.
// 의존성 없음(node: 모듈만) — 생성기가 .ts를 바로 import해요.
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const PACKAGE_SCHEMA = 1;
export const MANIFEST_FILE = 'manifest.json';

/** 구성 요소. 설치 위치는 plan.ts targetFor() */
export type ComponentName = 'runtime' | 'daemon' | 'app' | 'hub' | 'extension';
export const COMPONENT_NAMES: readonly ComponentName[] = ['runtime', 'daemon', 'app', 'hub', 'extension'];

export interface FileEntry {
  /** 구성 요소 폴더 기준 상대 경로, `/` 구분 */
  path: string;
  size: number;
  sha256: string;
}

export interface ComponentManifest {
  name: ComponentName;
  /** runtime: Node 버전(24.20.0), app: `<업스트림 태그>-<mark42 커밋>`(설치 폴더 Mk42-<버전>), 나머지: 패키지 버전 또는 자기 버전 */
  version: string;
  /** 패키지 루트 기준 폴더(`/` 구분) */
  dir: string;
  /** treeHash(files) */
  treeHash: string;
  fileCount: number;
  size: number;
}

export interface PackageManifest {
  schema: typeof PACKAGE_SCHEMA;
  product: 'mark42';
  /** `YYYY.MMDD.HHmmss`(UTC) — 숫자 자리별로 비교해요(compareVersions) */
  version: string;
  createdAt: string;
  source: { mark42Commit: string; dirty: boolean; upstreamTag: string; upstreamCommit?: string };
  /** 앱 실행 파일 상대 경로(app 구성 요소 기준) */
  appExe: string;
  components: ComponentManifest[];
  /**
   * 업데이트 채널(계약 C4, `package.mjs --update-channel`) — 패키지 루트의 update.json `{channel,url,publicKey}`와
   * (내부 채널만) update.secret의 크기·sha256. 엔진은 해시를 맞춘 뒤에만 설치 기록·home에 옮겨요. 없으면 지난 설치의 채널을 그대로 둬요.
   */
  update?: PackageUpdate;
}

export const UPDATE_CONFIG_FILE = 'update.json';
export const UPDATE_SECRET_FILE = 'update.secret';

export interface PackageFileRef {
  file: string;
  size: number;
  sha256: string;
}

export interface PackageUpdate {
  channel: string;
  config: PackageFileRef;
  secret?: PackageFileRef;
}

function validatePackageUpdate(raw: unknown, fail: (m: string) => never): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('update is not an object');
  const u = raw as Record<string, unknown>;
  if (typeof u.channel !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(u.channel)) fail('bad update channel');
  const ref = (v: unknown, file: string, max: number, what: string) => {
    if (typeof v !== 'object' || v === null) fail(`bad ${what}`);
    const r = v as Record<string, unknown>;
    if (r.file !== file) fail(`${what} file must be ${file}`);
    if (typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size < 1 || r.size > max) fail(`bad ${what} size`);
    if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) fail(`bad ${what} sha256`);
  };
  ref(u.config, UPDATE_CONFIG_FILE, 16 * 1024, 'update config');
  if (u.secret !== undefined) ref(u.secret, UPDATE_SECRET_FILE, 1024, 'update secret');
}

/** 정렬한 «경로\t크기\t해시» 줄의 SHA-256 — 같은 파일 집합·내용이면 같은 값 */
export function treeHash(files: readonly FileEntry[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\t${f.size}\t${f.sha256}\n`);
  }
  return h.digest('hex');
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * 앱(Mk42.exe)이 실행 중에 자기 폴더에 쓰는 파일(2026-11-03 실측): exe 옆 `debug.log`, Node 컴파일 캐시 `resources/app/node-compile-cache/`.
 * 패키지에 넣지 않고, 이미 깔린 버전 폴더를 비교할 때도 보지 않아요.
 */
export function isAppRuntimeArtifact(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').toLowerCase();
  return p === 'debug.log' || p === 'chrome_debug.log' || p === 'resources/app/node-compile-cache' || p.startsWith('resources/app/node-compile-cache/');
}

/** 한 번에 해시하는 파일 수 — 앱 폴더(파일 3천 개, 1.1GB)는 하나씩 하면 디스크를 다 못 써요 */
const HASH_CONCURRENCY = 8;

/** 폴더 아래 모든 파일(재귀, 정션·심볼릭 링크는 따라가지 않고 거절) */
export async function listFiles(root: string): Promise<FileEntry[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error(`links are not allowed in a package: ${full}`);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) found.push(full);
      else throw new Error(`unexpected entry in a package: ${full}`);
    }
  };
  await walk(root);
  const out: FileEntry[] = new Array(found.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < found.length) {
      const i = next++;
      const full = found[i]!;
      const st = await fsp.stat(full);
      out[i] = { path: relative(root, full).split(sep).join('/'), size: st.size, sha256: await sha256File(full) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, found.length) }, worker));
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface TreeSummary {
  treeHash: string;
  fileCount: number;
  size: number;
}

export async function summarizeTree(root: string): Promise<TreeSummary> {
  const files = await listFiles(root);
  return { treeHash: treeHash(files), fileCount: files.length, size: files.reduce((n, f) => n + f.size, 0) };
}

/** `2026.1103.104512` 같은 점 구분 숫자 비교(숫자가 아닌 자리는 문자열로) */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const c = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

/** UTC 시각 → 패키지 버전 `YYYY.MMDD.HHmmss`(앞자리 0 없는 숫자 자리) */
export function packageVersionAt(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const mmdd = Number(`${d.getUTCMonth() + 1}${p2(d.getUTCDate())}`);
  const hms = Number(`${d.getUTCHours()}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`);
  return `${d.getUTCFullYear()}.${mmdd}.${hms}`;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

/** 형태 검사 — 경로 조각에 `..`·드라이브·구분자가 못 들어오게(설치 폴더 이름으로 써요) */
export function validateManifest(raw: unknown): PackageManifest {
  const fail = (m: string): never => {
    throw new Error(`invalid ${MANIFEST_FILE}: ${m}`);
  };
  if (typeof raw !== 'object' || raw === null) return fail('not an object');
  const m = raw as Record<string, unknown>;
  if (m.schema !== PACKAGE_SCHEMA) fail(`unsupported schema ${String(m.schema)}`);
  if (m.product !== 'mark42') fail('product is not mark42');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) fail('bad version');
  if (typeof m.appExe !== 'string' || !/^[A-Za-z0-9._-]+\.exe$/.test(m.appExe)) fail('bad appExe');
  if (!Array.isArray(m.components)) fail('components is not an array');
  const seen = new Set<string>();
  for (const c of m.components as unknown[]) {
    if (typeof c !== 'object' || c === null) fail('component is not an object');
    const x = c as Record<string, unknown>;
    if (!COMPONENT_NAMES.includes(x.name as ComponentName)) fail(`unknown component ${String(x.name)}`);
    if (seen.has(x.name as string)) fail(`duplicate component ${String(x.name)}`);
    seen.add(x.name as string);
    if (typeof x.version !== 'string' || !SAFE_SEGMENT.test(x.version)) fail(`bad version for ${String(x.name)}`);
    if (typeof x.dir !== 'string' || !/^[A-Za-z0-9_-]+$/.test(x.dir)) fail(`bad dir for ${String(x.name)}`);
    if (typeof x.treeHash !== 'string' || !/^[0-9a-f]{64}$/.test(x.treeHash)) fail(`bad treeHash for ${String(x.name)}`);
  }
  for (const need of COMPONENT_NAMES) if (!seen.has(need)) fail(`missing component ${need}`);
  if (m.update !== undefined) validatePackageUpdate(m.update, fail);
  return raw as PackageManifest;
}
