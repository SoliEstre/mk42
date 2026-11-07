// 판(edition): 공개판(이 코드의 기본)과 비공개 덧층(overlay)을 얹은 판이 갈라지는 지점을 한곳에 모아요.
// 코어 모듈은 덧층을 직접 import하지 않아요 — 조립 지점(main.ts)이 overlay/index.ts의 훅을 받아 각 모듈의 옵션으로 넘겨요.
// 이 파일과 overlay/index.ts의 «빈 덧층»은 공개 repo에서 바뀌지 않는 계약이에요. 덧층은 overlay/index.ts만 바꿔 끼워요.
import { DEFAULT_RESUME_PROMPTS, type PinnedDefaults, type ResumeMode } from '@mark42/protocol';
import type { UiLanguage } from './i18n.ts';
import type { AgentExtensionSource, ReferenceSource } from './agentUpdates.ts';
import type { DiscoveredInstall } from './launcher.ts';
import type { Logger } from './log.ts';
import type { AppProduct, DaemonSettings } from './registry.ts';

/** 판마다 다를 수 있는 기본값 — 값이 저장돼 있으면 저장된 값이 이겨요(기본값은 빠졌을 때만) */
export interface EditionDefaults {
  /** 부팅 재개 모드 */
  resumeMode: ResumeMode;
  /** 새 고정 세션의 재개 프롬프트 */
  resumePrompt(lang: UiLanguage): string;
  /** 새 고정 세션의 자동 전송 */
  pinnedAutoSend: boolean;
  /** 창을 띄울 앱(settings.defaultAppProduct가 없을 때) */
  defaultAppProduct: AppProduct;
}

export const PUBLIC_DEFAULTS: EditionDefaults = {
  resumeMode: 'console',
  resumePrompt: (lang) => DEFAULT_RESUME_PROMPTS[lang],
  pinnedAutoSend: false,
  defaultAppProduct: 'mark42',
};

/** 덧층 기본값을 공개 기본값 위에 */
export function editionDefaults(overlay: DaemonOverlay): EditionDefaults {
  return { ...PUBLIC_DEFAULTS, ...(overlay.defaults ?? {}) };
}

/** pinned.defaults — 지금 언어의 기본 문장과, «기본값»으로 보는 모든 문장(두 언어) */
export function pinnedDefaults(d: EditionDefaults, lang: UiLanguage): PinnedDefaults {
  const known = new Set<string>([d.resumePrompt('en'), d.resumePrompt('ko'), ...Object.values(DEFAULT_RESUME_PROMPTS)]);
  return { resumePrompt: d.resumePrompt(lang), autoSend: d.pinnedAutoSend, knownPrompts: [...known] };
}

/** 창 띄우기 덧층 — 없으면 settings.apps(설치기가 쓴 Mk42 앱)만 써요 */
export interface LaunchOverlay {
  /** settings.apps 말고 더 찾을 설치본 */
  extraInstalls?(settings: DaemonSettings, env: NodeJS.ProcessEnv): Promise<DiscoveredInstall[]>;
  /** product가 정해지지 않은 띄우기에서 고를 버전 */
  preferredVersion?(product: AppProduct, settings: DaemonSettings): string | undefined;
  /**
   * 설치 기록에 user-data·확장 폴더가 없을 때 쓸 폴더. undefined = 앱 기본(Mark42가 폴더를 정하지 않음).
   * prepare가 true면 띄우기 전에 준비(복사·동기화)도 해요.
   */
  userDataDirs?(
    install: DiscoveredInstall,
    ctx: { home: string; settings: DaemonSettings; log?: Logger; prepare: boolean },
  ): Promise<{ userDataDir: string; extensionsDir: string; managed: boolean } | undefined>;
  /** Mark42가 정한 user-data로 띄우기 직전(분리 폴더·관리 설정을 맞춘 뒤) */
  onUserDataLaunch?(install: DiscoveredInstall, userDataDir: string): Promise<void>;
  /** 실행 직전 — 돌려준 함수는 실행 뒤에 불러요 */
  beforeSpawn?(install: DiscoveredInstall, settings: DaemonSettings, log?: Logger): Promise<(() => void) | undefined>;
  /** 첫 실행 때 갤러리 대신 다른 곳에서 마련하는 확장 VSIX(확장 ID → VSIX 경로) */
  sideload?(ctx: { home: string }): Record<string, (onProgress?: (received: number, total: number | undefined) => void) => Promise<string>>;
  /** sideload로 마련하는 확장 — 검증 경로(agentUpdates)를 타지 않아요 */
  sideloadIds?: readonly string[];
}

/** 에이전트 확장 공급 덧층 */
export interface AgentSupplyOverlay {
  /** 공개 기본(Open VSX + 검증) 대신 쓸 공급원 */
  sources?(defaults: readonly AgentExtensionSource[]): readonly AgentExtensionSource[];
  /** 검증 기준(같은 버전의 기준 해시) */
  reference?: ReferenceSource;
}

/** 조립 지점이 덧층에 주는 것 */
export interface OverlayContext {
  home: string;
  getSettings: () => DaemonSettings;
  /** 설치본 목록(덧층 extraInstalls 포함) */
  installs: () => Promise<DiscoveredInstall[]>;
  hubExe: () => string;
  log: Logger;
}

/** 덧층이 시작한 상주 서비스 */
export interface OverlayServices {
  launch?: Pick<LaunchOverlay, 'onUserDataLaunch'>;
  close?(): void;
}

export interface DaemonOverlay {
  /** 판 이름(로그·진단). 공개판은 없음 */
  edition?: string;
  defaults?: Partial<EditionDefaults>;
  launch?: LaunchOverlay;
  /** 폴더별 앱 고르기(settings.defaultAppProduct보다 먼저) */
  resolveAppProduct?(folderPath: string, settings: DaemonSettings): AppProduct | undefined;
  /** 창이 hello로 알린 앱 이름 → 앱(공개판은 nameLong 'Mark42'만) */
  appProductOfName?(appName: string): AppProduct | undefined;
  agentSupply?(ctx: OverlayContext): AgentSupplyOverlay;
  /** 데몬이 준비된 뒤 한 번(파이프 주인일 때) */
  start?(ctx: OverlayContext): Promise<OverlayServices | undefined> | OverlayServices | undefined;
}

/** 갤러리 대상 플랫폼(Open VSX·Marketplace targetPlatform) */
export function galleryTargetPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  const a = arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'armhf' : 'x64';
  return `${os}-${a}`;
}
