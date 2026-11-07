// 앱 실행기 — 설치본 고르기, 역할 워크스페이스로 앱 창 띄우기. 포커스 = 같은 워크스페이스를 다시 실행.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WindowRole } from '@mark42/protocol';
import { pathKey, samePath } from '@mark42/protocol/paths';
import type { AppInstall, AppProduct, DaemonSettings } from './registry.ts';
import type { DownloadProgressFn } from './gallery.ts';
import { PUBLIC_DEFAULTS, type LaunchOverlay } from './edition.ts';
import { errMsg, type Logger } from './log.ts';
import {
  ExtensionInstaller,
  hasExtensionVersion,
  KOREAN_LANGUAGE_PACK_ID,
  MARK42_EXTENSION_ID,
  missingExtensions,
  resolveVsix,
  type EnsureRequest,
  type ExtensionUpdateResult,
  type VsixRef,
} from './extensions.ts';
import { ensureArgvLocale, mk42ArgvJsonPath } from './argvJson.ts';
import { ensureLanguagePacksJson } from './languagePacks.ts';
import { osUiLanguage, type UiLanguage } from './i18n.ts';
import type { LaunchProgressLike, LaunchStepEnd, LaunchTicket } from './launchProgress.ts';
import { applyManagedUserSettings, userDefaultUserDataDir } from './userData.ts';

/** 확장 ID — ~/.vscode/extensions 폴더 이름(anthropic.claude-code-2.1.301-win32-x64, openai.chatgpt-26.1007.21434-win32-x64)으로 확인 */
export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
export const CODEX_EXTENSION_ID = 'openai.chatgpt';

/**
 * R1 — 버전별 확장 폴더에 첫 실행 때 깔아 둘 에이전트 확장 (WBS 3.4). 한국어 언어 팩은 Windows 표시 언어가 한국어일 때만
 * ({@link requiredExtensions}, C2 2026-11-05) — 이 목록에는 없어요.
 */
export const REQUIRED_EXTENSIONS: readonly string[] = [CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID];

/** 그 표시 언어에서 깔아 둘 확장 — ko면 한국어 언어 팩 + 에이전트 확장, 아니면 에이전트 확장만 */
export function requiredExtensions(lang: UiLanguage): string[] {
  return lang === 'ko' ? [KOREAN_LANGUAGE_PACK_ID, ...REQUIRED_EXTENSIONS] : [...REQUIRED_EXTENSIONS];
}

export const ROLE_PROFILES: Record<WindowRole, string | undefined> = {
  hub: undefined,
  'agent-claude': 'Agent-Claude',
  'agent-codex': 'Agent-Codex',
  editor: 'Editor',
};

/**
 * R4 «한 창에 확장 하나» 임시방편 — 역할별로 끌 에이전트 확장 (architecture §3: hub·editor는 둘 다 끔).
 * 정본은 워크스페이스 범위 «사용 안 함(작업 영역)»이지만 CLI·API가 없어서, PoC는 실행 인자 --disable-extension을 써요.
 * 한계: 앱 재시작 뒤 창 복원(window.restoreWindows)으로 열린 창에는 인자가 없어서 다시 켜져요.
 */
export function disabledAgentExtensions(role: WindowRole): string[] {
  switch (role) {
    case 'agent-claude':
      return [CODEX_EXTENSION_ID];
    case 'agent-codex':
      return [CLAUDE_EXTENSION_ID];
    default:
      return [CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID];
  }
}

/**
 * D47: agent 창은 편집·SCM을 하지 않아서 끄는 기본 확장(git-base는 남겨요 — 다른 확장이 기대요).
 * 언어 기능(JSON·TS·markdown·html·css)은 창마다 언어 서버를 띄워요(2026-10-29 창 12개에 약 1.7GB). 문법 색칠은 vscode.<언어>
 * 확장이 따로 맡아서 남고, 에이전트 창의 링크는 편집 창으로 넘어가요(사용자 결정 2026-10-29).
 */
export const AGENT_WINDOW_TRIMMED_BUILTINS: readonly string[] = [
  'vscode.git',
  'vscode.github',
  'vscode.npm',
  'vscode.merge-conflict',
  'vscode.emmet',
  'vscode.json-language-features',
  'vscode.typescript-language-features',
  'vscode.markdown-language-features',
  'vscode.html-language-features',
  'vscode.css-language-features',
];

/** 창 역할에 따라 끌 확장: 다른 에이전트(D31) + (켜 두면) agent 창의 쓰지 않는 기본 확장(D47) */
export function disabledExtensionsFor(role: WindowRole, settings: { disableOtherAgentExtension?: boolean; trimAgentWindowBuiltins?: boolean }): string[] {
  const out = settings.disableOtherAgentExtension !== false ? disabledAgentExtensions(role) : [];
  if (settings.trimAgentWindowBuiltins === true && (role === 'agent-claude' || role === 'agent-codex')) out.push(...AGENT_WINDOW_TRIMMED_BUILTINS);
  return out;
}

export interface DiscoveredInstall extends AppInstall {
  /** registry = settings.apps(설치기가 써요), 그 밖의 값은 덧층이 찾은 설치본 */
  source: string;
}

export interface SpawnResult {
  pid?: number;
}
/** 분리 실행 — 테스트에서 가짜로 바꿔요 */
export type SpawnFn = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<SpawnResult>;

export const defaultSpawn: SpawnFn = (command, args, env) =>
  new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(command, args, { detached: true, windowsHide: false, shell: false, stdio: 'ignore', env });
    } catch (e) {
      reject(e);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });

/**
 * 데몬이 확장 호스트에서 띄워졌으면 ELECTRON_RUN_AS_NODE·VSCODE_* 가 상속돼요.
 * 그대로 Code.exe에 넘기면 Code.exe가 node로 돌거나(ELECTRON_RUN_AS_NODE) 부모 창 IPC로 붙을 수 있어서 지워요.
 */
export function sanitizeLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    const K = k.toUpperCase();
    if (K.startsWith('VSCODE_') || K.startsWith('ELECTRON_')) continue;
    out[k] = v;
  }
  return out;
}

/** settings.apps + 덧층이 더 찾은 설치본(같은 exe는 한 번만) */
export async function discoverInstalls(
  settings: DaemonSettings,
  env: NodeJS.ProcessEnv = process.env,
  overlay?: Pick<LaunchOverlay, 'extraInstalls'>,
): Promise<DiscoveredInstall[]> {
  const out: DiscoveredInstall[] = settings.apps.map((a) => ({ ...a, source: 'registry' }));
  for (const extra of (await overlay?.extraInstalls?.(settings, env)) ?? []) {
    if (!out.some((a) => a.exe.toLowerCase() === extra.exe.toLowerCase())) out.push(extra);
  }
  return out;
}

export function selectInstall(
  installs: DiscoveredInstall[],
  preferredVersion?: string,
): DiscoveredInstall | undefined {
  if (preferredVersion) {
    const hit = installs.find((i) => i.version === preferredVersion);
    if (hit) return hit;
  }
  return installs.find((i) => i.source === 'registry') ?? installs[0];
}

export interface LaunchArgsInput {
  workspaceFile: string;
  userDataDir?: string;
  extensionsDir?: string;
  /** Daemon/005: 공유 저장소·에이전트 플러그인 분리 + 업데이트·최근 항목 끔 (Mark42 전용 user-data 창만) */
  separation?: SeparationDirs;
  profile?: string;
  disableExtensions?: string[];
  extensionDevelopmentPath?: string;
}

/** Daemon/005: Mark42 전용 user-data 창에 붙이는 인자 (VS Code 1.143.1 argv 옵션에서 확인) */
export const SEPARATION_FLAGS: readonly string[] = ['--disable-updates', '--skip-add-to-recently-opened'];

export function buildLaunchArgs(input: LaunchArgsInput): string[] {
  const args: string[] = [];
  if (input.userDataDir) args.push('--user-data-dir', input.userDataDir);
  if (input.extensionsDir) args.push('--extensions-dir', input.extensionsDir);
  if (input.separation) {
    const s = input.separation;
    args.push('--shared-data-dir', s.sharedDataDir, '--agent-plugins-dir', s.agentPluginsDir, ...SEPARATION_FLAGS);
  }
  if (input.profile) args.push('--profile', input.profile);
  if (input.extensionDevelopmentPath) args.push(`--extensionDevelopmentPath=${input.extensionDevelopmentPath}`);
  for (const id of input.disableExtensions ?? []) args.push('--disable-extension', id);
  args.push(input.workspaceFile);
  return args;
}

export interface LaunchRequest {
  workspaceFile: string;
  role: WindowRole;
  /** 이 버전으로 (없으면 settings.defaultAppVersion) */
  appVersion?: string;
  /** 이 앱으로 (없으면 settings.defaultAppProduct, 그것도 없으면 'vscode') */
  appProduct?: AppProduct;
  /**
   * 포커스용: 그 버전 설치본이 없으면 실패. 다른 버전 Code.exe로 같은 워크스페이스를 열면
   * 메인 파이프가 버전별이라 포커스 대신 창이 하나 더 떠요(보고서 §6 메인 단일화).
   */
  exactVersion?: boolean;
}
export interface LaunchOutcome {
  exe: string;
  args: string[];
  version: string;
  pid?: number;
}

export interface AppLauncherLike {
  launch(req: LaunchRequest): Promise<LaunchOutcome>;
}

/**
 * 창마다 다른 개발 경로. VS Code 메인의 openExtensionDevelopmentHostWindow는 config.extensionDevelopmentPath가 같은
 * 창이 있으면(URI 비교, 경로 문자열 기준) 새 창 대신 그 창을 다시 로드하고 포커스해요(1.141.1·1.142.0 mainImpl.js).
 * 같은 확장 폴더를 가리키는 정션을 워크스페이스 파일마다 따로 만들면 창끼리 겹치지 않아요.
 */
export async function ensureDevExtensionLink(home: string, workspaceFile: string, target: string, log?: Logger): Promise<string> {
  const id = createHash('sha256').update(pathKey(workspaceFile)).digest('hex').slice(0, 12);
  const dir = join(home, 'devext');
  const link = join(dir, id);
  const want = resolve(target);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const cur = await fsp.readlink(link);
    if (samePath(resolve(cur), want)) return link;
    await fsp.unlink(link);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EINVAL' || code === 'EISDIR' || code === 'EPERM') {
      // 정션이 아닌 진짜 폴더가 그 자리에 있어요 — 건드리지 않고 원래 경로를 써요
      log?.warn(`devext ${link} is not a link; using ${target} as is`);
      return target;
    }
    if (code !== 'ENOENT') throw e;
  }
  await fsp.symlink(want, link, 'junction');
  return link;
}

/** Daemon/005: Mark42 전용 user-data 창이 평소 VS Code와 나누지 않을 폴더 둘 */
export interface SeparationDirs {
  /** `--shared-data-dir` — `~/.vscode-shared` 대신(GitHub 로그인 비밀·신뢰 폴더) */
  sharedDataDir: string;
  /** `--agent-plugins-dir` — `~/.vscode/agent-plugins` 대신(user-data와 상관없이 기본은 사용자 홈이라 따로 지정해야 해요) */
  agentPluginsDir: string;
}

/**
 * Daemon/005: 분리를 껐거나(separateFromUserVsCode false), user-data가 없거나(사용자 기본 프로필), 그 user-data가 사용자 본인의
 * VS Code 데이터면 undefined예요. isolateUserData는 `<home>\data\vscode-shared`·`agent-plugins`(버전끼리 공유 — D19가 `Local State`
 * 키를 이어 주니까), apps[].userDataDir는 그 폴더마다 `<userDataDir>-shared`·`-agent-plugins`(부모 폴더가 같은 다른 설치본과도
 * 안 섞이게), apps[].sharedDataDir가 있으면 그것.
 */
export function separationDirsFor(
  settings: Pick<DaemonSettings, 'separateFromUserVsCode'>,
  install: Pick<AppInstall, 'userDataDir' | 'sharedDataDir'>,
  home: string,
  userDataDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SeparationDirs | undefined {
  if (settings.separateFromUserVsCode === false || !userDataDir) return undefined;
  if (samePath(userDataDir, userDefaultUserDataDir(env))) return undefined;
  if (!install.userDataDir) {
    return { sharedDataDir: join(home, 'data', 'vscode-shared'), agentPluginsDir: join(home, 'data', 'agent-plugins') };
  }
  const base = userDataDir.replace(/[\\/]+$/, '');
  return { sharedDataDir: install.sharedDataDir ?? `${base}-shared`, agentPluginsDir: `${base}-agent-plugins` };
}

/** 첫 실행 확장 설치(R1)와 Mark42 확장 .vsix 설치 — {@link ExtensionInstaller}, 시험에서 가짜로 바꿔요 */
export interface ExtensionSetup {
  ensure(req: EnsureRequest): Promise<void>;
  ensureVsix(req: EnsureRequest, vsix: VsixRef): Promise<boolean>;
  /** 에이전트 확장 올리기(agentUpdates.ts) — 같은 설치기라 빠진 확장 깔기와 차례를 지켜요 */
  updateExtension?(req: EnsureRequest, id: string, latest: string, installArg: () => Promise<string>): Promise<ExtensionUpdateResult>;
}

export interface AppLauncherOptions {
  home: string;
  getSettings: () => DaemonSettings;
  spawn?: SpawnFn;
  /** 창마다 다른 개발 경로를 돌려줘요 (기본 ensureDevExtensionLink) */
  devPathFor?: (workspaceFile: string, target: string) => Promise<string>;
  discover?: (settings: DaemonSettings) => Promise<DiscoveredInstall[]>;
  /** 첫 실행 확장 설치 (기본 {@link ExtensionInstaller}) */
  extensions?: ExtensionSetup;
  /** 판 덧층(edition.ts) — 설치본 더 찾기·user-data 폴더·실행 전후·사이드로드. 조립 지점이 넘겨요(뒤에 채워도 돼요) */
  overlay?: LaunchOverlay;
  /** settings.defaultAppProduct가 없을 때 띄울 앱(판 기본값) */
  defaultAppProduct?: AppProduct;
  /**
   * Mk42에 에이전트 확장이 없을 때 — 갤러리 판은 검증을 거쳐야 해서 여기서 갤러리 ID로 깔지 않고 업데이트 확인(agentUpdates.ts)에 맡겨요.
   * Promise를 돌려주면(끝 = 'done'|'failed'|'skipped', 다른 값은 done) 그동안 진행 창에 그 확장 단계로 보여요.
   */
  onVerifiedExtensionMissing?: (id: string) => unknown;
  /** 창 띄우기 준비 진행(launchProgress.ts). 없으면 보고하지 않아요 */
  progress?: LaunchProgressLike;
  /** OS 표시 언어(기본 {@link osUiLanguage}) — ko면 한국어 언어 팩을 창보다 먼저 깔아요 */
  uiLanguage?: () => Promise<UiLanguage>;
  /** Mk42.exe의 argv.json(기본 `<사용자 홈>\.mk42\argv.json`) — 시험에서 바꿔요 */
  argvJsonPath?: string;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
}

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchError';
  }
}

export class AppLauncher implements AppLauncherLike {
  #opts: AppLauncherOptions;
  #spawn: SpawnFn;
  #extensions: ExtensionSetup;
  constructor(opts: AppLauncherOptions) {
    this.#opts = opts;
    this.#spawn = opts.spawn ?? defaultSpawn;
    this.#extensions =
      opts.extensions ??
      new ExtensionInstaller({ ids: REQUIRED_EXTENSIONS, env: sanitizeLaunchEnv(opts.env ?? process.env), log: opts.log });
  }

  async installs(): Promise<DiscoveredInstall[]> {
    const settings = this.#opts.getSettings();
    return this.#opts.discover ? this.#opts.discover(settings) : discoverInstalls(settings, this.#opts.env, this.#opts.overlay);
  }

  /**
   * 그 설치본의 user-data·확장 폴더 — 설치 기록에 있으면 그것, 없으면 덧층이 정한 폴더(managed), 둘 다 없으면 앱 기본(undefined).
   * prepare면 띄우기 전 준비(폴더 만들기·덧층 준비)도 해요.
   */
  async #dataDirs(
    install: DiscoveredInstall,
    settings: DaemonSettings,
    prepare: boolean,
  ): Promise<{ userDataDir?: string; extensionsDir?: string; managed: boolean }> {
    if (install.userDataDir) {
      if (prepare) await fsp.mkdir(install.userDataDir, { recursive: true }); // settings.apps에 직접 지정한 폴더는 그대로 써요
      // 확장 폴더만 빠졌으면 덧층이 정한 확장 폴더를 써요(그 폴더는 Mark42가 맡아요)
      const d = install.extensionsDir
        ? undefined
        : await this.#opts.overlay?.userDataDirs?.(install, { home: this.#opts.home, settings, log: this.#opts.log, prepare: false });
      return { userDataDir: install.userDataDir, extensionsDir: install.extensionsDir ?? d?.extensionsDir, managed: d?.managed === true };
    }
    const d = await this.#opts.overlay?.userDataDirs?.(install, { home: this.#opts.home, settings, log: this.#opts.log, prepare });
    return d
      ? { userDataDir: d.userDataDir, extensionsDir: install.extensionsDir ?? d.extensionsDir, managed: d.managed && !install.extensionsDir }
      : { extensionsDir: install.extensionsDir, managed: false };
  }

  /**
   * Mk42 앱(기본 선택)의 확장 폴더 설치 대상 — 창 띄우기와 같은 user-data·확장·공유 폴더. Mk42가 없거나 확장 폴더가 정해지지 않았으면 undefined.
   * 에이전트 확장 업데이트(agentUpdates.ts)가 써요.
   */
  async mark42ExtensionTarget(): Promise<(EnsureRequest & { appVersion: string }) | undefined> {
    const settings = this.#opts.getSettings();
    if (settings.installExtensions === false) return undefined;
    const install = selectInstall((await this.installs()).filter((i) => i.product === 'mark42'));
    if (!install) return undefined;
    const { userDataDir, extensionsDir } = await this.#dataDirs(install, settings, false);
    if (!userDataDir || !extensionsDir) return undefined;
    const separation = separationDirsFor(settings, install, this.#opts.home, userDataDir, this.#opts.env ?? process.env);
    return {
      exe: install.exe,
      userDataDir,
      extensionsDir,
      sharedDataDir: separation?.sharedDataDir,
      agentPluginsDir: separation?.agentPluginsDir,
      appVersion: install.version,
    };
  }

  /** {@link ExtensionSetup.updateExtension} — 설치기가 지원하지 않으면 실패로 돌려줘요 */
  updateExtension(req: EnsureRequest, id: string, latest: string, installArg: () => Promise<string>): Promise<ExtensionUpdateResult> {
    if (!this.#extensions.updateExtension) return Promise.resolve({ status: 'failed', error: 'installer cannot update extensions' });
    return this.#extensions.updateExtension(req, id, latest, installArg);
  }

  async launch(req: LaunchRequest): Promise<LaunchOutcome> {
    // 새 창 띄우기만 준비 진행을 보고해요(이미 떠 있는 창의 포커스는 아니에요)
    const ticket = req.exactVersion ? undefined : this.#opts.progress?.begin();
    try {
      return await this.#launch(req, ticket);
    } finally {
      ticket?.seal();
    }
  }

  #uiLanguage(): Promise<UiLanguage> {
    return (this.#opts.uiLanguage ?? osUiLanguage)().catch(() => 'en' as const);
  }

  /**
   * 한국어 Windows면 한국어 언어 팩을 창보다 먼저 깔고(작아요, 차례에서 앞에 서요) argv.json에 locale ko를 넣어요 — 첫 창이 다시 시작
   * 없이 한국어로 떠요. 언어 팩이 없으면(설치 실패) locale은 넣지 않아요(다음 띄우기 때 다시). 실패해도 창은 떠요.
   */
  async #prepareLanguage(target: EnsureRequest, lang: UiLanguage, ticket: LaunchTicket | undefined): Promise<void> {
    if (lang !== 'ko') return;
    const log = this.#opts.log;
    const ids = [KOREAN_LANGUAGE_PACK_ID];
    let present = (await missingExtensions(target.extensionsDir, ids)).length === 0;
    if (!present) {
      ticket?.start('language-pack');
      await this.#extensions.ensure({ ...target, ids, priority: true }).catch((e) => log?.warn(`Korean language pack: ${errMsg(e)}`));
      present = (await missingExtensions(target.extensionsDir, ids)).length === 0;
      ticket?.finish('language-pack', present ? 'done' : 'failed');
      if (!present) log?.warn(`Korean language pack not installed into ${target.extensionsDir}; the window opens in English`);
    }
    if (!present) return;
    const argv = this.#opts.argvJsonPath ?? mk42ArgvJsonPath();
    await ensureArgvLocale(argv, 'ko', log).catch((e) => log?.warn(`argv.json locale: ${errMsg(e)}`));
    // CLI로 깐 언어 팩은 languagepacks.json을 쓰지 않아요(공유 프로세스가 창이 뜬 뒤에야 써요) — 창은 시작할 때 그 파일로 번역을 찾아서,
    // 없으면 locale ko여도 첫 창이 영어예요(검토 2026-11-05). VS Code LanguagePacksCache와 같은 모양으로 미리 써 둬요
    await ensureLanguagePacksJson(target.userDataDir, target.extensionsDir, KOREAN_LANGUAGE_PACK_ID, log).catch((e) =>
      log?.warn(`languagepacks.json: ${errMsg(e)}`),
    );
  }

  /** 뒤에서 하는 설치의 Promise를 단계로 — 끝나면 done/failed/skipped */
  #trackStep(ticket: LaunchTicket | undefined, id: 'codex-extension' | 'claude-extension', p: Promise<unknown>): void {
    if (!ticket) return;
    ticket.start(id);
    p.then(
      (v) => ticket.finish(id, v === 'failed' || v === 'skipped' ? (v as LaunchStepEnd) : 'done'),
      () => ticket.finish(id, 'failed'),
    );
  }

  async #launch(req: LaunchRequest, ticket: LaunchTicket | undefined): Promise<LaunchOutcome> {
    const settings = this.#opts.getSettings();
    const product = req.appProduct ?? settings.defaultAppProduct ?? this.#opts.defaultAppProduct ?? PUBLIC_DEFAULTS.defaultAppProduct;
    // 같은 버전 번호여도 다른 앱(제품)이면 다른 앱이에요 — 고른 앱의 설치본 중에서만 골라요(기록에 product가 없으면 'vscode')
    const installs = (await this.installs()).filter((i) => (i.product ?? 'vscode') === product);
    const install = req.exactVersion
      ? installs.find((i) => i.version === req.appVersion)
      : selectInstall(installs, req.appVersion ?? this.#opts.overlay?.preferredVersion?.(product, settings));
    if (!install) {
      throw new LaunchError(
        req.exactVersion
          ? `${product} app version ${req.appVersion ?? '?'} not installed`
          : product === 'mark42'
            ? 'no Mk42 app in settings.apps (reinstall Mk42)'
            : `no ${product} app install found (set settings.apps in registry.json)`,
      );
    }
    const dirs = await this.#dataDirs(install, settings, true);
    const { userDataDir, extensionsDir } = dirs;
    // 평소 VS Code와 공유 저장소·에이전트 플러그인·업데이트·창 복원을 나누지 않게(Mark42 전용 user-data만)
    const separation = separationDirsFor(settings, install, this.#opts.home, userDataDir, this.#opts.env ?? process.env);
    if (separation && userDataDir) {
      for (const dir of [separation.sharedDataDir, separation.agentPluginsDir]) {
        // 못 만들어도 인자는 그대로 넘겨요 — 빼면 평소 ~/.vscode-shared에 다시 묶여요(VS Code가 쓸 때 만들어요)
        await fsp.mkdir(dir, { recursive: true }).catch((e) => this.#opts.log?.warn(`separation dir ${dir} not created (${errMsg(e)})`));
      }
      await applyManagedUserSettings(userDataDir, this.#opts.log, this.#opts.env ?? process.env);
      await this.#opts.overlay?.onUserDataLaunch?.(install, userDataDir);
    }
    const sharedDataDir = separation?.sharedDataDir;
    const agentPluginsDir = separation?.agentPluginsDir;
    // Mark42가 맡은 확장 폴더에만 깔아요(사용자가 지정하지 않은 기본 ~/.vscode/extensions는 그대로).
    // 창을 기다리게 하지 않아요(Codex VSIX가 약 600MB): 창은 바로 띄우고 설치는 뒤에서. 이미 떠 있는 창의 포커스(exactVersion)에서는 안 해요.
    // 빠진 확장은 다음 창 띄우기 때 다시 시도해요. 창이 기다리는 것(Mark42 확장 .vsix·한국어 언어 팩)은 차례에서 앞에 서요.
    let languageReady: Promise<void> = Promise.resolve();
    if (install.product === 'mark42' && userDataDir && extensionsDir && settings.installExtensions !== false) {
      if (!req.exactVersion) {
        const target: EnsureRequest = { exe: install.exe, userDataDir, extensionsDir, sharedDataDir, agentPluginsDir };
        const lang = await this.#uiLanguage();
        languageReady = this.#prepareLanguage(target, lang, ticket).catch((e) => this.#opts.log?.warn(`language prep: ${errMsg(e)}`));
        // 에이전트 확장은 검증해서 깔아야 해요 — 빠졌으면 업데이트 확인이 검증한 뒤 깔아요(확인 못 하면 창에서 사용자에게 물어요).
        // 덧층이 사이드로드로 마련하는 확장만 여기서 바로 깔아요
        const overlay = this.#opts.overlay;
        const sideloadIds = overlay?.sideloadIds ?? [];
        const verified = [CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID].filter((id) => !sideloadIds.includes(id));
        for (const id of await missingExtensions(extensionsDir, verified).catch(() => [])) {
          const r = this.#opts.onVerifiedExtensionMissing?.(id);
          if (r && typeof (r as Promise<unknown>).then === 'function') {
            this.#trackStep(ticket, id === CODEX_EXTENSION_ID ? 'codex-extension' : 'claude-extension', r as Promise<unknown>);
          }
        }
        const background = requiredExtensions(lang).filter((id) => id !== KOREAN_LANGUAGE_PACK_ID && !verified.includes(id));
        if (background.length > 0) {
          const codexMissing = background.includes(CODEX_EXTENSION_ID) && (await missingExtensions(extensionsDir, [CODEX_EXTENSION_ID])).length > 0;
          const onProgress: DownloadProgressFn | undefined = ticket
            ? (received, total) => ticket.bytes('codex-extension', received, total)
            : undefined;
          const sideloads = overlay?.sideload?.({ home: this.#opts.home }) ?? {};
          const sideload = Object.fromEntries(
            Object.entries(sideloads).map(([id, fetchVsix]) => [id, () => fetchVsix(id === CODEX_EXTENSION_ID ? onProgress : undefined)]),
          );
          if (codexMissing) ticket?.start('codex-extension'); // 받기 진행이 바로 붙게 먼저
          const bg = this.#extensions
            .ensure({ ...target, ids: background, sideload })
            .catch((e) => this.#opts.log?.warn(`Mark42 extensions: ${errMsg(e)}`));
          if (codexMissing) {
            this.#trackStep(
              ticket,
              'codex-extension',
              bg.then(async () => ((await missingExtensions(extensionsDir, [CODEX_EXTENSION_ID])).length > 0 ? 'failed' : 'done')),
            );
          }
        }
      }
    } else if (dirs.managed && userDataDir && extensionsDir && settings.installExtensions !== false)
      // 덧층이 정한 다른 앱의 확장 폴더 — 필요한 확장을 깔아요
      await this.#extensions.ensure({ exe: install.exe, userDataDir, extensionsDir, sharedDataDir, agentPluginsDir, ids: requiredExtensions(await this.#uiLanguage()) });
    // Mark42 확장 .vsix: Mark42가 맡은 확장 폴더(버전별 또는 settings.apps에 직접 지정)에 깔고, 깔렸으면 개발 경로를 붙이지 않아요.
    // 사용자 기본 ~/.vscode/extensions(확장 폴더 지정 없음)에는 깔지 않아요.
    let packaged = false;
    if (settings.extensionVsix && userDataDir && extensionsDir) {
      const vsix = await resolveVsix(settings.extensionVsix);
      if (vsix) {
        const needed = !(await hasExtensionVersion(extensionsDir, MARK42_EXTENSION_ID, vsix.version));
        if (needed) ticket?.start('mark42-extension');
        packaged = await this.#extensions
          .ensureVsix({ exe: install.exe, userDataDir, extensionsDir, sharedDataDir, agentPluginsDir }, vsix)
          .catch((e) => (this.#opts.log?.warn(`Mark42 extension: ${errMsg(e)}`), false));
        if (needed) ticket?.finish('mark42-extension', packaged ? 'done' : 'failed');
      } else this.#opts.log?.warn(`extensionVsix ${settings.extensionVsix}: no mark42-<version>.vsix there; using the development path`);
    }
    await languageReady;
    const disableExtensions = disabledExtensionsFor(req.role, settings);
    let devPath: string | undefined;
    if (!packaged && !req.exactVersion && settings.extensionDevelopmentPath) {
      const target = settings.extensionDevelopmentPath;
      try {
        devPath = this.#opts.devPathFor
          ? await this.#opts.devPathFor(req.workspaceFile, target)
          : await ensureDevExtensionLink(this.#opts.home, req.workspaceFile, target, this.#opts.log);
      } catch (e) {
        // 정션을 못 만들면 같은 경로를 써요 — 그 경우 기존 Mark42 창이 다시 로드될 수 있어요
        this.#opts.log?.warn(`devext link failed (${errMsg(e)}); existing dev-host window may be reloaded`);
        devPath = target;
      }
    }
    const args = buildLaunchArgs({
      workspaceFile: req.workspaceFile,
      userDataDir,
      extensionsDir,
      separation,
      profile: settings.useRoleProfiles === true ? ROLE_PROFILES[req.role] : undefined,
      disableExtensions,
      extensionDevelopmentPath: devPath,
    });
    const launched = await this.#opts.overlay?.beforeSpawn?.(install, settings, this.#opts.log);
    try {
      const r = await this.#spawn(install.exe, args, sanitizeLaunchEnv(this.#opts.env ?? process.env));
      this.#opts.log?.info(`launched ${install.exe} (${install.version}) pid=${r.pid ?? '?'} ${req.workspaceFile}`);
      // 준비가 있었던 띄우기면 창의 Mark42 확장이 hello할 때까지 «창 여는 중»
      ticket?.waitForWindow(req.workspaceFile);
      return { exe: install.exe, args, version: install.version, pid: r.pid };
    } catch (e) {
      throw new LaunchError(`spawn failed: ${install.exe}: ${errMsg(e)}`);
    } finally {
      launched?.();
    }
  }
}
