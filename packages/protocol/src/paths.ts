// 경로 정규화·폴더 ID·데몬 위치. Node 전용(확장 호스트·데몬).
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, resolve, win32 } from 'node:path';

const isWin = process.platform === 'win32';

/**
 * 정규화 절대 경로: `\\?\` 제거, 구분자 통일, 드라이브 문자 대문자, 끝 구분자 제거(루트 제외).
 * Codex rollout_path에 `C:\…`와 `\\?\C:\…`가 섞여 있어서 비교 전에 꼭 거쳐요.
 */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    let s = p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/\//g, '\\');
    s = win32.resolve(s);
    if (/^[a-z]:/.test(s)) s = s[0]!.toUpperCase() + s.slice(1);
    if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
    return s;
  }
  let s = resolve(p);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** 비교 키: Windows는 대소문자를 무시해요. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const n = normalizePath(p, platform);
  return platform === 'win32' ? n.toLowerCase() : n;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** 폴더 ID = 비교 키의 sha256 앞 16자 */
export function folderIdFor(p: string, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256').update(pathKey(p, platform)).digest('hex').slice(0, 16);
}

export function defaultMark42Home(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MARK42_HOME) return env.MARK42_HOME;
  if (isWin) return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Mark42');
  return join(homedir(), '.mark42');
}

/** `\\.\pipe\mark42-m42d-<sha256(사용자명 + MARK42_HOME) 앞 12자>` (Windows), 그 외는 유닉스 소켓 */
export function defaultPipeName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MARK42_PIPE) return env.MARK42_PIPE;
  const home = defaultMark42Home(env);
  const key = createHash('sha256')
    .update(`${userInfo().username}\n${home}`)
    .digest('hex')
    .slice(0, 12);
  return isWin ? `\\\\.\\pipe\\mark42-m42d-${key}` : join(home, `m42d-${key}.sock`);
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(homedir(), '.codex');
}
