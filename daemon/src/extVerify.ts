// 갤러리 확장 검증. 에이전트 확장의 갤러리(Open VSX) 판을 깔기 전에 같은 버전의 기준 해시(공식 판)와 파일별 sha256을 비교해요 —
// 갤러리 판이 바뀌었으면(악성 빌드 보고가 있었어요) 깔기 전에 걸러요. 후보 VSIX는 시험 폴더에 깔아 해시하고, 설치기가 package.json에
// 넣는 `__metadata`는 빼고 비교해요. 기준 해시를 어디서 얻는지는 판(edition)이 정해요(agentUpdates.ts ReferenceSource).
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defaultRun, resolveCliScript, type RunFn } from './extensions.ts';
import { errMsg, type Logger } from './log.ts';

const STAGE_TIMEOUT_MS = 10 * 60_000;

/** 파일 경로(`/`로) → sha256 hex */
export type TreeHashes = Record<string, string>;

export type TreeComparison = { same: true } | { same: false; differ: string[]; missing: string[]; extra: string[] };

/** 설치된 확장 폴더의 파일별 해시. package.json은 `__metadata`(설치 시각 등)를 뺀 정규화 JSON으로 해시해요 */
export async function hashTree(root: string): Promise<TreeHashes> {
  const out: TreeHashes = {};
  const walk = async (dir: string): Promise<void> => {
    for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (d.isFile()) {
        const rel = relative(root, p).split(sep).join('/');
        out[rel] = rel === 'package.json' ? await hashManifest(p) : await hashFile(p);
      }
    }
  };
  await walk(root);
  return out;
}

async function hashFile(p: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', resolve)
      .on('error', reject);
  });
  return h.digest('hex');
}

async function hashManifest(p: string): Promise<string> {
  const raw = await fsp.readFile(p, 'utf8');
  let text = raw;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    delete j.__metadata;
    text = stableStringify(j);
  } catch {
    // JSON이 아니면 그대로
  }
  return createHash('sha256').update(text).digest('hex');
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function compareTrees(reference: TreeHashes, candidate: TreeHashes): TreeComparison {
  const differ: string[] = [];
  const missing: string[] = [];
  for (const [k, h] of Object.entries(reference)) {
    if (!(k in candidate)) missing.push(k);
    else if (candidate[k] !== h) differ.push(k);
  }
  const extra = Object.keys(candidate).filter((k) => !(k in reference));
  return differ.length || missing.length || extra.length ? { same: false, differ, missing, extra } : { same: true };
}

export interface StageInstallOptions {
  /** 깔 때 쓸 앱(Code.exe 또는 Mk42.exe) */
  exe: string;
  /** `--install-extension` 인자: `<id>@<버전>`(갤러리) 또는 VSIX 경로 */
  installArg: string;
  id: string;
  /** 시험 폴더를 만들 곳(끝나면 지워요) */
  workDir: string;
  env: NodeJS.ProcessEnv;
  run?: RunFn;
  log?: Logger;
}

/**
 * 시험 폴더(user-data·extensions 따로)에 깔고 그 확장 폴더의 해시를 돌려줘요. 평소 프로필·Mk42 확장 폴더는 건드리지 않아요.
 * 깔리지 않았으면 throw.
 */
export async function stageInstallAndHash(o: StageInstallOptions): Promise<{ id?: string; version: string; files: TreeHashes }> {
  const cli = await resolveCliScript(o.exe);
  if (!cli) throw new Error(`no cli.js next to ${o.exe}`);
  const dir = join(o.workDir, `stage-${process.pid}-${Date.now().toString(36)}`);
  const ud = join(dir, 'ud');
  const ext = join(dir, 'ext');
  await fsp.mkdir(ud, { recursive: true });
  await fsp.mkdir(ext, { recursive: true });
  try {
    const r = await (o.run ?? defaultRun)(
      o.exe,
      // 공유 저장소·에이전트 플러그인도 시험 폴더로(Daemon/005 — 평소 ~/.vscode-shared를 열지 않게)
      [cli, '--user-data-dir', ud, '--extensions-dir', ext, '--shared-data-dir', join(dir, 'shared'), '--agent-plugins-dir', join(dir, 'plugins'), '--install-extension', o.installArg, '--force'],
      { ...o.env, ELECTRON_RUN_AS_NODE: '1' },
      STAGE_TIMEOUT_MS,
    );
    const prefix = `${o.id.toLowerCase()}-`;
    const folder = (await fsp.readdir(ext, { withFileTypes: true })).find((d) => d.isDirectory() && d.name.toLowerCase().startsWith(prefix));
    if (!folder) throw new Error(`not installed (exit ${r.code ?? 'killed'}): ${r.output.trim().slice(-300)}`);
    const root = join(ext, folder.name);
    // 폴더 이름이 아니라 그 안의 package.json으로 ID·버전을 확인해요
    let id: string | undefined;
    let version = /^(\d+(?:\.\d+)*)/.exec(folder.name.slice(prefix.length))?.[1] ?? '?';
    try {
      const pj = JSON.parse(await fsp.readFile(join(root, 'package.json'), 'utf8')) as { publisher?: unknown; name?: unknown; version?: unknown };
      if (typeof pj.publisher === 'string' && typeof pj.name === 'string') id = `${pj.publisher}.${pj.name}`;
      if (typeof pj.version === 'string') version = pj.version;
    } catch {
      // 없으면 폴더 이름으로
    }
    return { id, version, files: await hashTree(root) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch((e) => o.log?.warn(`verify: ${dir} not removed (${errMsg(e)})`));
  }
}
