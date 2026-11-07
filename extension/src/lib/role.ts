// 역할 판별·WindowInfo 조립 — vscode에 의존하지 않는 로직이에요(역할 워크스페이스 신뢰 판단만 파일 시스템 realpath를 봐요).
import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { AgentKind, ExtensionVersion, WindowInfo, WindowRole } from '@mark42/protocol';
import { defaultMark42Home, pathKey } from '@mark42/protocol/paths';
import { sourceText, type Translate } from './l10n.ts';

export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
export const CODEX_EXTENSION_ID = 'openai.chatgpt';
export const MARK42_EXTENSION_ID = 'mark42.mark42';
export const TRACKED_EXTENSION_IDS: readonly string[] = [CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID, MARK42_EXTENSION_ID];

export type VirtualDocPlacement = 'agentWindow' | 'auxWindow';

const ROLES: ReadonlySet<string> = new Set<WindowRole>(['hub', 'agent-claude', 'agent-codex', 'editor']);

export function parseRole(v: unknown): WindowRole | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return ROLES.has(s) ? (s as WindowRole) : undefined;
}

export function agentOfRole(role: WindowRole | undefined): AgentKind | undefined {
  if (role === 'agent-claude') return 'claude';
  if (role === 'agent-codex') return 'codex';
  return undefined;
}

export function isAgentRole(role: WindowRole | undefined): role is 'agent-claude' | 'agent-codex' {
  return agentOfRole(role) !== undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

export interface RoleConfig {
  /** undefined = 관리하지 않는 창(침습적인 동작 없음) */
  role: WindowRole | undefined;
  slotId: string | undefined;
  folderPath: string | undefined;
  autoSend: boolean;
  pipeName: string | undefined;
  daemonPath: string | undefined;
  nodePath: string;
  virtualDocPlacement: VirtualDocPlacement;
  sender: 'osKeys' | 'none';
  /** 신뢰한 역할 워크스페이스의 Mark42 home(readRoleConfigScoped만 채워요). 없으면 기본 home을 써요. */
  home?: string;
}

/** `get(key)`는 `mark42.` 접두사 없는 키로 설정 값을 돌려줘요(vscode.workspace.getConfiguration('mark42').get). */
export function readRoleConfig(get: (key: string) => unknown): RoleConfig {
  const placement = get('virtualDocPlacement');
  const sender = get('sender');
  const autoSend = get('autoSend');
  return {
    role: parseRole(get('role')),
    slotId: str(get('slotId')),
    folderPath: str(get('folderPath')),
    autoSend: typeof autoSend === 'boolean' ? autoSend : true,
    pipeName: str(get('pipeName')),
    daemonPath: str(get('daemonPath')),
    nodePath: str(get('nodePath')) ?? 'node',
    virtualDocPlacement: placement === 'auxWindow' ? 'auxWindow' : 'agentWindow',
    sender: sender === 'none' ? 'none' : 'osKeys',
  };
}

/** vscode.WorkspaceConfiguration.inspect() 결과 중 쓰는 부분 */
export interface ScopedValue {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

// 데몬(workspaces.ts roleWorkspacePath)이 만드는 모양 그대로만:
//   hub    → <home>\roles\_hub\hub.code-workspace
//   editor → <home>\roles\<folderId 16 hex>\editor.code-workspace
//   agent  → <home>\roles\<folderId 16 hex>\agent-<claude|codex>.<slotId>.code-workspace
const ROLE_WS_FILE = /^(hub|agent-claude|agent-codex|editor)(?:\.([A-Za-z0-9_-]{1,64}))?\.code-workspace$/i;
const HUB_DIR = '_hub';
const FOLDER_DIR = /^[0-9a-f]{16}$/i;
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const MAX_PATH_CHARS = 4096;
const MAX_TRUSTED_HOMES = 16;

export interface TrustedRoleWorkspace {
  role: WindowRole;
  /** 정규화한 역할 워크스페이스 파일 경로 */
  file: string;
  /** 파일 경로에서 나온 Mark42 home(신뢰 목록의 하나와 같은 경로) — 데몬 인증 비밀(<home>\auth.secret)을 여기서 읽어요 */
  home: string;
}

export interface TrustOptions {
  platform?: NodeJS.Platform;
  /**
   * 실제 경로 확인(심볼릭 링크·정션·8.3 이름 풀기). 기본 fs.realpathSync.native.
   * null은 순수 문자열 검사만(단위 테스트 전용). 던지면 신뢰하지 않아요.
   */
  realpath?: ((p: string) => string) | null;
}

function defaultRealpath(p: string): string {
  return (realpathSync.native ?? realpathSync)(p);
}

/** Windows 경로 조각 하나가 다르게 해석될 여지가 없는지(ADS·끝 점/공백·예약 이름·와일드카드·빈 조각·`.`·`..`) */
function plainWinSegment(seg: string): boolean {
  if (seg.length === 0 || seg.length > 255 || seg === '.' || seg === '..') return false;
  if (/[<>:"|?*\\/]/.test(seg)) return false;
  if (/[. ]$/.test(seg)) return false;
  return !WIN_RESERVED.test(seg);
}

/**
 * 모호하지 않은 절대 로컬 경로로 바꿔요. 다르게 해석될 수 있으면 undefined(거부).
 * Windows: `\\?\` 접두사만 벗기고(`\\?\UNC\`·`\\.\`·UNC는 거부) `/`→`\`, 드라이브 대문자.
 * 그 뒤 win32.resolve가 바꾸는 게 하나라도 있으면(`..`·`.`·겹친 구분자 등) 거부해요.
 */
export function canonicalLocalPath(p: string, platform: NodeJS.Platform, allowTrailingSep = false): string | undefined {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_CHARS) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(p)) return undefined;
  if (platform === 'win32') {
    let s = p;
    if (/^[\\/]{2}[?.][\\/]/.test(s)) {
      if (!/^\\\\\?\\[A-Za-z]:\\/.test(s)) return undefined; // \\?\UNC\…, \\.\device, \\?\Volume{…}
      s = s.slice(4);
    }
    s = s.replace(/\//g, '\\');
    if (s.startsWith('\\')) return undefined; // UNC·루트 상대
    if (!/^[A-Za-z]:\\/.test(s)) return undefined; // 상대·드라이브 상대(C:x)
    s = s[0]!.toUpperCase() + s.slice(1);
    if (allowTrailingSep) while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
    if (s.length > 3) {
      for (const seg of s.slice(3).split('\\')) if (!plainWinSegment(seg)) return undefined;
    }
    return win32.resolve(s) === s ? s : undefined;
  }
  let s = p;
  if (!s.startsWith('/')) return undefined;
  if (allowTrailingSep) while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (s.length > 1) {
    for (const seg of s.slice(1).split('/')) if (seg.length === 0 || seg === '.' || seg === '..') return undefined;
  }
  return posix.resolve(s) === s ? s : undefined;
}

function keyOf(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? pathKey(p, 'win32') : p;
}

/**
 * 같은 경로인지. Windows는 pathKey(대소문자 무시)에 더해 ASCII만 접은 비교도 같아야 해요 —
 * JS toLowerCase는 NTFS가 다르게 보는 글자도 접어요(예: KELVIN SIGN U+212A → 'k'). 비ASCII 대소문자 차이는 거부(안전한 쪽).
 */
function samePathKey(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return a === b;
  const ascii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return keyOf(a, platform) === keyOf(b, platform) && ascii(a) === ascii(b);
}

/** 실제 경로(realpath 결과)를 비교할 수 있게 정규화 — `\\?\` 접두사만 허용, 나머지는 canonicalLocalPath와 같아요. */
function canonicalReal(p: string, platform: NodeJS.Platform): string | undefined {
  return canonicalLocalPath(p, platform, true);
}

/** 신뢰하는 Mark42 home 목록을 정규화해요(잘못된 항목은 버려요). */
export function canonicalTrustedHomes(homes: readonly unknown[], platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of homes.slice(0, MAX_TRUSTED_HOMES + 1)) {
    if (typeof h !== 'string') continue;
    const c = canonicalLocalPath(h.trim(), platform, true);
    if (!c) continue;
    const k = keyOf(c, platform);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * 데몬이 만든 역할 워크스페이스인지 — 이름만이 아니라 위치로 판단해요.
 * 신뢰 목록의 home 바로 아래 `<home>\roles\<dir>\<file>`에 있고, 실제 경로(심볼릭 링크·정션을 푼 뒤)도
 * `<실제 home>\roles\<dir>\<file>`이어야 해요. 저장소가 roles\x\hub.code-workspace를 싣고 와도 신뢰하지 않아요.
 * 신뢰 판단과 이후에 쓰는 값(역할·home)은 같은 정규화 경로에서 나와요.
 */
export function roleOfWorkspaceFile(
  file: string | undefined,
  trustedHomes: readonly string[],
  opts: TrustOptions = {},
): TrustedRoleWorkspace | undefined {
  if (!file) return undefined;
  const platform = opts.platform ?? process.platform;
  const sep = platform === 'win32' ? '\\' : '/';
  const canon = canonicalLocalPath(file, platform);
  if (!canon) return undefined;
  const parts = canon.split(sep);
  if (parts.length < 4) return undefined;
  const name = parts[parts.length - 1]!;
  const dir = parts[parts.length - 2]!;
  if (parts[parts.length - 3]!.toLowerCase() !== 'roles') return undefined;
  const m = ROLE_WS_FILE.exec(name);
  if (!m) return undefined;
  const role = parseRole(m[1]!.toLowerCase());
  if (!role) return undefined;
  const slot = m[2];
  if (isAgentRole(role) ? slot === undefined : slot !== undefined) return undefined;
  if (role === 'hub' ? dir.toLowerCase() !== HUB_DIR : !FOLDER_DIR.test(dir)) return undefined;
  let homeOfFile = parts.slice(0, -3).join(sep) || sep;
  if (platform === 'win32' && /^[A-Z]:$/.test(homeOfFile)) homeOfFile += '\\';
  const matched = canonicalTrustedHomes(trustedHomes, platform).find((h) => samePathKey(h, homeOfFile, platform));
  if (!matched) return undefined;
  const rp = opts.realpath === undefined ? defaultRealpath : opts.realpath;
  if (rp) {
    let realFile: string | undefined;
    let realHome: string | undefined;
    try {
      realFile = canonicalReal(rp(canon), platform);
      realHome = canonicalReal(rp(matched), platform);
    } catch {
      return undefined;
    }
    if (!realFile || !realHome) return undefined;
    const expected = [realHome.endsWith(sep) ? realHome.slice(0, -1) : realHome, 'roles', dir, name].join(sep);
    if (!samePathKey(realFile, expected, platform)) return undefined;
  }
  return { role, file: canon, home: homeOfFile };
}

export interface ScopedReadOptions extends TrustOptions {
  /** 기본 defaultMark42Home() */
  defaultHome?: string;
}

/** 신뢰하는 home = 기본 home + 사용자(global) 설정 mark42.trustedHomes. 워크스페이스·폴더 값은 보지 않아요. */
export function trustedHomesFrom(inspect: (key: string) => ScopedValue | undefined, defaultHome: string): string[] {
  const extra = inspect('trustedHomes')?.globalValue;
  return [defaultHome, ...(Array.isArray(extra) ? extra.slice(0, MAX_TRUSTED_HOMES) : [])].filter(
    (h): h is string => typeof h === 'string',
  );
}

/**
 * 범위를 따지는 설정 읽기.
 * - role·slotId·folderPath: 신뢰하는 home 아래 Mark42 역할 워크스페이스 파일의 값만(파일 이름의 역할과 같을 때). 폴더·사용자 설정은 무시해요.
 * - pipeName: 그 역할 워크스페이스 값 또는 사용자(global) 값.
 * - daemonPath·nodePath·trustedHomes: 사용자(global) 값만 — 워크스페이스가 실행 파일·신뢰 범위를 바꾸지 못해요.
 * - home: 신뢰한 역할 워크스페이스의 home(데몬 인증 비밀 위치). 아니면 undefined.
 * - 나머지: 보통 get().
 */
export function readRoleConfigScoped(
  inspect: (key: string) => ScopedValue | undefined,
  get: (key: string) => unknown,
  workspaceFile: string | undefined,
  opts: ScopedReadOptions = {},
): RoleConfig {
  const homes = trustedHomesFrom(inspect, opts.defaultHome ?? defaultMark42Home());
  const ws = roleOfWorkspaceFile(workspaceFile, homes, opts);
  const wsRole = parseRole(inspect('role')?.workspaceValue);
  const trusted = ws !== undefined && wsRole === ws.role;
  const fromWs = (k: string) => (trusted ? inspect(k)?.workspaceValue : undefined);
  const cfg = readRoleConfig((k) => {
    switch (k) {
      case 'role':
      case 'slotId':
      case 'folderPath':
        return fromWs(k);
      case 'pipeName':
        return fromWs(k) ?? inspect(k)?.globalValue;
      case 'daemonPath':
      case 'nodePath':
        return inspect(k)?.globalValue;
      default:
        return get(k);
    }
  });
  if (trusted) cfg.home = ws.home;
  return cfg;
}

export type DaemonSpawnSpec = { nodePath: string; entry: string } | { skip: string };

/**
 * D41 이름 변경(m42d → mk42d) 호환: 설정이 옛 번들 `…\m42d.mjs`(·.cjs·.js)를 가리키고 옆에 `mk42d.*`가 있으면 새 번들을 써요.
 * 다시 빌드해도 옛 번들은 지워지지 않아서, 옛 파일이 남아 있어도 새 번들이 있으면 새 번들이 우선이에요.
 */
export function preferRenamedDaemonEntry(entry: string, exists: (p: string) => boolean): string {
  const m = /^(.*[\\/])m42d(\.(?:mjs|cjs|js))$/i.exec(entry);
  if (!m) return entry;
  const renamed = `${m[1]}mk42d${m[2]}`;
  return exists(renamed) ? renamed : entry;
}

function isUncOrDevice(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

function isAbsoluteWin(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * hub 창이 데몬을 띄울지. 경로를 추측하지 않고, UNC·상대 경로는 거부해요.
 * 기본이 아닌 파이프면(다른 --home·--pipe 데몬용) 띄우지 않아요 — 기본 home·pipe로 엉뚱한 두 번째 데몬이 뜨지 않게.
 */
export function daemonSpawnSpec(cfg: RoleConfig, defaultPipe: string): DaemonSpawnSpec | undefined {
  if (cfg.role !== 'hub' || !cfg.daemonPath) return undefined;
  if (cfg.pipeName && cfg.pipeName.toLowerCase() !== defaultPipe.toLowerCase()) return { skip: 'custom pipe name (start that daemon yourself)' };
  const entry = cfg.daemonPath;
  if (isUncOrDevice(entry) || !isAbsoluteWin(entry)) return { skip: 'daemonPath must be an absolute local path' };
  if (!/\.(ts|mjs|cjs|js)$/i.test(entry)) return { skip: 'daemonPath must be a .ts/.mjs/.cjs/.js file' };
  const node = cfg.nodePath;
  const bare = !/[\\/:]/.test(node);
  if (!bare && (isUncOrDevice(node) || !isAbsoluteWin(node))) return { skip: 'nodePath must be a command name or an absolute local path' };
  return { nodePath: node, entry };
}

export interface HostEnv {
  workspaceFile: string | undefined;
  /** 열린 작업 영역 폴더(fsPath) */
  workspaceFolders: readonly string[];
  pid: number;
  appVersion: string;
  /** vscode.env.appName — «Mark42»면 Mk42 패치 빌드 */
  appName?: string;
  appCommit?: string;
  extensions: readonly ExtensionVersion[];
}

/** 역할 창이 아닌 경우의 folderPath는 첫 작업 영역 폴더로 채워요(hub는 비워요). */
export function resolveFolderPath(cfg: RoleConfig, env: HostEnv): string | undefined {
  if (cfg.role === 'hub') return undefined;
  return cfg.folderPath ?? env.workspaceFolders[0];
}

export function buildWindowInfo(cfg: RoleConfig, env: HostEnv, sessionId?: string): WindowInfo | undefined {
  if (!cfg.role) return undefined;
  const info: WindowInfo = {
    role: cfg.role,
    pid: env.pid,
    appVersion: env.appVersion,
    extensions: env.extensions.map((e) => ({ id: e.id, version: e.version })),
  };
  const folderPath = resolveFolderPath(cfg, env);
  if (folderPath) info.folderPath = folderPath;
  if (isAgentRole(cfg.role) && cfg.slotId) info.slotId = cfg.slotId;
  if (isAgentRole(cfg.role) && sessionId) info.sessionId = sessionId;
  if (env.workspaceFile) info.workspaceFile = env.workspaceFile;
  if (env.appCommit) info.appCommit = env.appCommit;
  if (env.appName) info.appName = env.appName;
  return info;
}

export function roleLabel(role: WindowRole | undefined, t: Translate = sourceText): string {
  switch (role) {
    case 'hub':
      return t('Hub window');
    case 'agent-claude':
      return t('Claude agent window');
    case 'agent-codex':
      return t('Codex agent window');
    case 'editor':
      return t('Editor window');
    default:
      return t('Unmanaged window');
  }
}
