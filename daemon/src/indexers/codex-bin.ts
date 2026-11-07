// codex 실행 파일 찾기 — VS Code Codex 확장 번들 > Codex Desktop 설치본 순서.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FindCodexOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 확장 폴더들 (기본: ~/.vscode/extensions). 패치 빌드에서는 Mark42 데이터 폴더를 넘겨요. */
  extensionsDirs?: string[];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 확장 bin 아래 플랫폼 폴더 이름 (예: windows-x86_64) */
function binPlatformDir(platform: NodeJS.Platform, arch: string): string | undefined {
  const a = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
  if (!a) return undefined;
  if (platform === 'win32') return `windows-${a}`;
  if (platform === 'linux') return `linux-${a}`;
  if (platform === 'darwin') return `macos-${a}`;
  return undefined;
}

/** 후보를 우선순위대로 돌려줘요 (존재하는 파일만). */
export function codexBinaryCandidates(o: FindCodexOptions = {}): string[] {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const out: string[] = [];
  if (env.MARK42_CODEX_BIN) out.push(env.MARK42_CODEX_BIN);

  const extDirs = o.extensionsDirs ?? [join(homedir(), '.vscode', 'extensions')];
  const pdir = binPlatformDir(platform, arch);
  const exts: { version: string; path: string }[] = [];
  for (const dir of extDirs) {
    for (const name of safeList(dir)) {
      const m = /^openai\.chatgpt-(\d+\.\d+\.\d+)(?:-.+)?$/.exec(name);
      if (!m) continue;
      const binRoot = join(dir, name, 'bin');
      const sub = pdir && existsSync(join(binRoot, pdir, exe)) ? pdir : safeList(binRoot).find((s) => existsSync(join(binRoot, s, exe)) && (!pdir || s === pdir));
      if (sub) exts.push({ version: m[1]!, path: join(binRoot, sub, exe) });
    }
  }
  exts.sort((a, b) => compareVersions(b.version, a.version));
  out.push(...exts.map((e) => e.path));

  if (platform === 'win32') {
    const base = join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    const desk: { mtime: number; path: string }[] = [];
    for (const h of safeList(base)) {
      const p = join(base, h, exe);
      try {
        desk.push({ mtime: statSync(p).mtimeMs, path: p });
      } catch {
        // 없음
      }
    }
    desk.sort((a, b) => b.mtime - a.mtime);
    out.push(...desk.map((d) => d.path));
  }
  return out.filter((p, i) => out.indexOf(p) === i && existsSync(p));
}

export function findCodexBinary(o: FindCodexOptions = {}): string | undefined {
  return codexBinaryCandidates(o)[0];
}
