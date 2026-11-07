// 설치 계획 — 구성 요소별 설치 위치와 registry.json 설정에 반영할 값. 순수 함수(시험 가능).
import { join, resolve } from 'node:path';
import { samePath } from '@mark42/protocol/paths';
import { splitTaskArguments } from '../autostart.ts';
import { parseArgs } from '../config.ts';
import type { AppInstall, DaemonSettings } from '../registry.ts';
import type { ComponentManifest, ComponentName, PackageManifest } from './manifest.ts';

export const HUB_EXE = 'mk42-hub.exe';
export const NODE_EXE = 'node.exe';
export const DAEMON_ENTRY = ['daemon', 'dist', 'mk42d.mjs'] as const;

/**
 * 설치 위치(<home> = %LOCALAPPDATA%\Mark42):
 * - 버전 폴더(덮어쓰지 않음, 같은 내용이면 건너뜀): runtime `runtime\node-<v>`, daemon `daemon\<v>`, app `app\Mk42-<v>`
 * - 한 자리(새 내용이면 바꿔 끼움): hub `hub\mk42-hub.exe`(작업 표시줄 고정·데몬 기본 경로), extension `extension\mark42-<v>.vsix`(폴더째 가장 높은 버전)
 */
export interface Target {
  kind: 'dir' | 'file';
  /** dir: 설치 폴더, file: 놓을 폴더 */
  path: string;
}

export function targetFor(home: string, c: Pick<ComponentManifest, 'name' | 'version'>): Target {
  switch (c.name) {
    case 'runtime':
      return { kind: 'dir', path: join(home, 'runtime', `node-${c.version}`) };
    case 'daemon':
      return { kind: 'dir', path: join(home, 'daemon', c.version) };
    case 'app':
      return { kind: 'dir', path: join(home, 'app', `Mk42-${c.version}`) };
    case 'hub':
      return { kind: 'file', path: join(home, 'hub') };
    case 'extension':
      return { kind: 'file', path: join(home, 'extension') };
  }
}

export interface InstallPaths {
  node: string;
  daemonEntry: string;
  appExe: string;
  hubExe: string;
  extensionDir: string;
}

export function installPaths(home: string, m: PackageManifest): InstallPaths {
  const c = (n: ComponentName) => m.components.find((x) => x.name === n)!;
  return {
    node: join(targetFor(home, c('runtime')).path, NODE_EXE),
    daemonEntry: join(targetFor(home, c('daemon')).path, ...DAEMON_ENTRY),
    appExe: join(targetFor(home, c('app')).path, m.appExe),
    hubExe: join(targetFor(home, c('hub')).path, HUB_EXE),
    extensionDir: targetFor(home, c('extension')).path,
  };
}

export interface SettingsChange {
  settings: DaemonSettings;
  notes: string[];
}

/**
 * registry.json settings에 설치를 반영해요.
 * - apps: Mark42 앱 항목을 새 exe로(같은 앱 버전의 옛 항목은 빼고 맨 앞에). user-data·확장 폴더는 기존 Mark42 항목 것을 이어받고,
 *   없으면 `<mk42Data>\user-data`·`\extensions`(제품 dataFolderName `.mk42`와 같은 자리)
 * - extensionVsix: 설치한 확장 폴더(창을 띄울 때 가장 높은 버전을 깔아요)
 * - defaultAppProduct: 처음 설치(registry가 없던)일 때만 'mark42' — 기존 사용자의 선택은 건드리지 않아요
 * 다른 설정(폴더별 앱, 개발용 extensionDevelopmentPath 등)은 그대로 둬요.
 */
export function applyInstallToSettings(
  current: DaemonSettings,
  p: { appVersion: string; appExe: string; extensionDir: string; mk42Data: string; fresh: boolean },
): SettingsChange {
  const notes: string[] = [];
  const isMark42 = (a: AppInstall) => a.product === 'mark42';
  const prev = current.apps.find(isMark42);
  const entry: AppInstall = {
    version: p.appVersion,
    product: 'mark42',
    exe: p.appExe,
    userDataDir: prev?.userDataDir ?? join(p.mk42Data, 'user-data'),
    extensionsDir: prev?.extensionsDir ?? join(p.mk42Data, 'extensions'),
    ...(prev?.sharedDataDir ? { sharedDataDir: prev.sharedDataDir } : {}),
  };
  const same = (a: AppInstall) => isMark42(a) && a.version === p.appVersion;
  const replaced = current.apps.filter(same);
  for (const r of replaced) if (r.exe !== p.appExe) notes.push(`app ${p.appVersion}: ${r.exe} -> ${p.appExe}`);
  if (replaced.length === 0) notes.push(`app ${p.appVersion}: added ${p.appExe}`);
  // 순서를 지켜요: 같은 버전의 첫 항목 자리에서 바꾸고(나머지는 빼고), 없으면 Mark42 항목들 맨 앞(없으면 끝)에 넣어요.
  // 데몬은 다른 데서 «처음 있는 exe»를 쓰기도 해요(창 아이콘의 Code.exe 출처) — 공식 VS Code 항목 앞으로 끼어들지 않게.
  // `at`은 같은 버전의 첫 항목이라 그 앞에는 뺄 항목이 없어요 → 빼고 난 목록에서도 같은 자리예요
  const at = current.apps.findIndex(same);
  const firstMark42 = current.apps.findIndex(isMark42);
  const apps = current.apps.filter((a) => !same(a));
  apps.splice(at >= 0 ? at : firstMark42 >= 0 ? firstMark42 : apps.length, 0, entry);
  const settings: DaemonSettings = { ...current, apps, extensionVsix: p.extensionDir };
  if (current.extensionVsix !== p.extensionDir) notes.push(`extensionVsix: ${current.extensionVsix ?? '(none)'} -> ${p.extensionDir}`);
  if (p.fresh && current.defaultAppProduct === undefined) {
    settings.defaultAppProduct = 'mark42';
    notes.push('defaultAppProduct: mark42 (first install)');
  }
  return { settings, notes };
}

/** `child`가 `parent` 폴더 안인지(Windows는 대소문자 무시) */
export function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  return c.length > p.length && c.startsWith(p) && (c[p.length] === '\\' || c[p.length] === '/');
}

/**
 * 제거: 이 home에 설치한 앱(`<home>\app\…`) 항목과 확장 폴더 설정을 registry.json settings에서 빼요. 다른 앱(공식 VS Code 등)·폴더 설정은 그대로.
 * Mark42 앱이 하나도 안 남으면 defaultAppProduct 'mark42'도 빼요(데몬이 없는 앱을 기본으로 고르지 않게).
 */
export function removeInstallFromSettings(current: DaemonSettings, home: string): SettingsChange {
  const notes: string[] = [];
  const appRoot = join(home, 'app');
  const apps = current.apps.filter((a) => {
    const ours = isInside(a.exe, appRoot);
    if (ours) notes.push(`app ${a.version}: removed ${a.exe}`);
    return !ours;
  });
  const settings: DaemonSettings = { ...current, apps };
  if (current.extensionVsix !== undefined && (samePath(current.extensionVsix, join(home, 'extension')) || isInside(current.extensionVsix, join(home, 'extension')))) {
    delete settings.extensionVsix;
    notes.push(`extensionVsix: ${current.extensionVsix} -> (none)`);
  }
  if (settings.defaultAppProduct === 'mark42' && !apps.some((a) => a.product === 'mark42')) {
    delete settings.defaultAppProduct;
    notes.push('defaultAppProduct: mark42 -> (none) (no Mark42 app left)');
  }
  return { settings, notes };
}

/** 앱 구성 요소 버전 `1.143.1-2aca49f` → registry apps[].version에 쓰는 업스트림 버전 `1.143.1` */
export function upstreamVersionOf(appVersion: string): string {
  const m = /^(\d+\.\d+\.\d+)/.exec(appVersion);
  return m ? m[1]! : appVersion;
}

export type TaskDecision = 'create' | 'update' | 'leave-off' | 'leave-other' | 'skip';

/**
 * 로그온 작업(`Mark42\mk42d`, 사용자마다 하나)을 어떻게 할지. 작업이 다른 home·pipe의 데몬을 띄우면 손대지 않아요
 * (시험·두 번째 home 설치가 사용자의 진짜 작업을 빼앗지 않게).
 * - 작업 있음: 이 home·pipe 것이면 새 경로로 바꾸고(--no-autostart여도 — 옛 데몬을 가리킨 채 두지 않게), 아니면 그대로
 * - 작업 없음: 기본 home의 처음 설치이고 --no-autostart가 아니면 만들고, 아니면 그대로(사용자가 껐거나, 시험·두 번째 home)
 */
export function decideTask(p: {
  noAutostart: boolean;
  fresh: boolean;
  defaultHome: boolean;
  current: { args: string[] } | undefined;
  home: string;
  pipe: string;
  env?: NodeJS.ProcessEnv;
}): TaskDecision {
  if (!p.current) return p.fresh && p.defaultHome && !p.noAutostart ? 'create' : p.noAutostart ? 'skip' : 'leave-off';
  const [, ...rest] = p.current.args;
  let theirs: { home: string; pipe: string };
  try {
    theirs = parseArgs(rest, p.env ?? process.env);
  } catch {
    return 'leave-other';
  }
  return samePath(theirs.home, p.home) && theirs.pipe.toLowerCase() === p.pipe.toLowerCase() ? 'update' : 'leave-other';
}

/**
 * 프로세스 명령줄이 이 파이프의 mk42d인지(옛 데몬을 프로세스로 끌 때). 명령줄을 인자로 나눠 번들(`mk42d.mjs`·옛 `m42d.mjs`) 뒤의
 * 인자를 데몬과 똑같이 풀어서(--pipe가 없으면 --home·기본값에서 만든 파이프) 정확히 같은 파이프일 때만 — 다른 home의 데몬이나
 * 이름이 비슷한 파이프는 건드리지 않아요. 데몬이 띄울 때만 쓴 MARK42_* 환경 변수는 알 수 없어서 없는 것으로 봐요.
 */
export function isDaemonCommandLine(cmd: string, pipe: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const tokens = splitTaskArguments(cmd);
  const i = tokens.findIndex((t) => /(^|[\\/])mk?42d\.(mjs|cjs|js)$/i.test(t));
  if (i < 0) return false;
  const clean: NodeJS.ProcessEnv = { ...env };
  delete clean.MARK42_HOME;
  delete clean.MARK42_PIPE;
  try {
    return parseArgs(tokens.slice(i + 1), clean).pipe.toLowerCase() === pipe.toLowerCase();
  } catch {
    return false;
  }
}

/** 설치 기록의 업데이트 자리(계약 C4) — 채널 없는 설치는 모두 null */
export interface UpdateRecord {
  channel: string | null;
  url: string | null;
  publicKey: string | null;
}

export type SecretAction = 'write' | 'keep' | 'remove';

/**
 * 이번 설치의 install.json `update`와 `<home>\update.secret` 처리:
 * - 패키지에 update.json이 없으면 지난 설치의 채널·자격 증명을 그대로(없으면 null)
 * - 있으면 그 채널로. 패키지에 update.secret이 있으면 덮어쓰고, 없으면 같은 채널·주소일 때만 지난 것을 두고 다르면 지워요
 *   (다른 채널·서버로 옛 자격 증명을 보내지 않게)
 */
export function planUpdateRecord(
  prev: Partial<UpdateRecord> | undefined,
  pkg: { channel: string; url: string; publicKey: string } | undefined,
  pkgHasSecret: boolean,
): { update: UpdateRecord; secret: SecretAction } {
  const previous: UpdateRecord = {
    channel: typeof prev?.channel === 'string' ? prev.channel : null,
    url: typeof prev?.url === 'string' ? prev.url : null,
    publicKey: typeof prev?.publicKey === 'string' ? prev.publicKey : null,
  };
  if (!pkg) return { update: previous, secret: 'keep' };
  const update: UpdateRecord = { channel: pkg.channel, url: pkg.url, publicKey: pkg.publicKey };
  if (pkgHasSecret) return { update, secret: 'write' };
  return { update, secret: previous.channel === pkg.channel && previous.url === pkg.url ? 'keep' : 'remove' };
}
