// 공용 데이터 타입(데몬·확장·통합 창)

export type AgentKind = 'claude' | 'codex';
export type WindowRole = 'hub' | 'agent-claude' | 'agent-codex' | 'editor';

export const AGENT_ROLES: Record<AgentKind, WindowRole> = {
  claude: 'agent-claude',
  codex: 'agent-codex',
};

export interface Folder {
  /** 정규화 경로의 sha256 앞 16자 */
  id: string;
  /** 정규화 절대 경로 */
  path: string;
  label: string;
  /** ISO-8601 */
  addedAt: string;
}

export interface ExtensionVersion {
  id: string;
  version: string;
}

export interface WindowInfo {
  /** 데몬이 hello 때 발급 */
  windowId?: string;
  role: WindowRole;
  /** agent 역할의 세션 슬롯 (D18 한 창 한 세션) */
  slotId?: string;
  /** 슬롯에 묶인 세션 (window.sessionBound 뒤) */
  sessionId?: string;
  /** hub는 없음 */
  folderPath?: string;
  workspaceFile?: string;
  /** 확장 호스트 pid */
  pid: number;
  /** vscode.version */
  appVersion: string;
  /** vscode.env.appName — «Mark42»이면 Mk42 패치 빌드, 아니면 공식 VS Code(같은 appVersion이어도 다른 앱) */
  appName?: string;
  appCommit?: string;
  /** Claude·Codex·Mark42 버전 (스모크 기준) */
  extensions: ExtensionVersion[];
}

export type SessionStatus = 'idle' | 'busy' | 'waiting' | 'stopped';

export interface SessionSummary {
  agent: AgentKind;
  /** Claude 세션 uuid / Codex threadId */
  id: string;
  /** 정규화 경로 */
  cwd: string;
  title?: string;
  /** 앞 200자 */
  lastPrompt?: string;
  model?: string;
  effort?: string;
  /** ISO-8601 */
  updatedAt: string;
  /** 살아 있는 세션만 idle/busy/waiting */
  status?: SessionStatus;
  /** Codex 서브에이전트의 부모 스레드 (D22) */
  parentId?: string;
  isSubagent?: boolean;
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeSettings {
  model?: string;
  effort?: ClaudeEffort;
  ultracode?: boolean;
}

export interface CodexSettings {
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandbox?: string;
  collaborationMode?: string;
  serviceTier?: string;
}

export type AgentSettings = ClaudeSettings | CodexSettings;

export interface PinnedSession {
  id: string;
  folderPath: string;
  agent: AgentKind;
  sessionId: string;
  label?: string;
  /** 에이전트별 키 집합 */
  settings: AgentSettings;
  /** 세션별 수정 가능 (R12) */
  resumePrompt: string;
  /** 재개 때 프롬프트를 보내기까지 할지(끄면 채우기만). 새로 고정할 때 기본값은 판마다 달라요(pinned.defaults) */
  autoSend: boolean;
  /** 부팅 자동 재개 대상 여부 */
  enabled: boolean;
  /** 재개 순서 */
  order: number;
  /** 통합 창에서 묶어 보는 사용자 그룹 이름(없으면 그룹 없음) */
  group?: string;
}

/** 고정 세션 그룹 이름 최대 길이 */
export const PINNED_GROUP_MAX = 60;

/** 기본 재개 프롬프트(UI 언어별). 판(edition)이 다른 문장을 쓰면 데몬이 pinned.defaults로 알려 줘요 */
export const DEFAULT_RESUME_PROMPTS: Readonly<Record<'en' | 'ko', string>> = {
  en: 'The computer has restarted. Please pick up where you left off and continue any unfinished work.',
  ko: '컴퓨터가 재시작됐어요. 하던 작업이 있으면 이어서 진행해 주세요.',
};

/** 새 고정 세션 기본값(pinned.defaults) */
export interface PinnedDefaults {
  /** 지금 UI 언어의 기본 재개 프롬프트 */
  resumePrompt: string;
  autoSend: boolean;
  /** «기본값»으로 보는 문장들(모든 언어) — 이 중 하나면 «기본값으로» 단추를 숨겨요 */
  knownPrompts: string[];
}

export type LinkKind = 'file' | 'web' | 'preview';

/** 부팅 재개 모드 (D28): (a) 콘솔 세션에서 / (b) 첫 RemoteApp 세션에서 */
export type ResumeMode = 'console' | 'firstRemoteApp';

/**
 * 확장 출처 검증: verified = 갤러리 판이 공식 판의 기준 해시와 파일별로 같음, unverified = 대조할 기준이 없음(아직 없음·받기 실패),
 * mismatch = 같은 버전인데 파일이 다름, marketplace = 신뢰하는 출처에서 받아서 출처 자체가 기준(판 덧층의 공급원)
 */
export type ExtensionVerification = 'verified' | 'unverified' | 'mismatch' | 'marketplace';

/** 데몬이 올리는 에이전트 확장(Claude Code·Codex: 갤러리 판 + 검증, 판 덧층이 공급원을 바꿀 수 있어요)의 업데이트 상태 */
export interface AgentExtensionUpdate {
  id: string;
  /** Mk42 확장 폴더의 가장 높은 버전(확인·설치 뒤) */
  installed?: string;
  /** 깔린 버전의 검증 결과(아직 안 했으면 없음) */
  installedVerification?: ExtensionVerification;
  /** 확인한 최신 정식판 */
  latest?: string;
  /**
   * current = 최신, updated = 이번에 깔림, failed = 확인·설치 실패, pending = 검증 안 된 새 버전이 사용자 확인을 기다림,
   * blocked = Marketplace 판과 달라 깔지 않음
   */
  status: 'current' | 'updated' | 'failed' | 'pending' | 'blocked';
  /** 새 버전(latest)의 검증 결과 */
  verification?: ExtensionVerification;
  /** 사용자 확인을 기다리는 버전(status pending) */
  pending?: string;
  /** 검증되지 않은·막힌 이유 */
  reason?: string;
  error?: string;
}

/**
 * Mk42 자체 업데이트 상태(데몬 updater.ts, 계약 C4). disabled = 설치 기록에 업데이트 채널이 없음(개발 실행·채널 없는 패키지).
 * available = 서명을 맞춘 새 판이 있지만 자동 받기(settings.update.autoDownload)가 꺼져 있어 아직 받지 않았어요(update.download를 기다려요).
 * ready = 새 판 설치 파일을 받아 서명·크기·sha256을 맞췄어요(사용자 «설치» 또는 settings.update.autoInstall을 기다려요).
 */
export type Mk42UpdateState = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

/** 자체 업데이트 자동 동작(registry.json settings.update) — download 기본 켬(D55), install 기본 꺼짐 */
export interface Mk42UpdateAuto {
  /** 새 판을 찾으면 바로 받아요(끄면 available에서 update.download를 기다려요) */
  download: boolean;
  /** 받아 확인하면 묻지 않고 바로 조용한 설치를 띄워요 */
  install: boolean;
}

export interface Mk42UpdateStatus {
  state: Mk42UpdateState;
  /** 설치된 패키지 판(install.json package.version, `YYYY.MMDD.HHmmss`). 설치 기록이 없으면 'unknown' */
  current: string;
  /** 업데이트 채널(internal·stable) — 있을 때만 */
  channel?: string;
  /** 서버가 알린 최신 판(서명 확인 뒤) */
  latest?: string;
  /** 최신 판 설명 — 데몬이 Windows 표시 언어(ko·en)로 골라요 */
  notes?: string;
  /** 최신 판 설치 파일 크기(바이트) — available·downloading·ready일 때 */
  size?: number;
  /** 받는 중일 때 바이트 */
  progress?: { received: number; total: number };
  /** 마지막 실패 한 줄(영어, 자격 증명 없음) */
  error?: string;
  /** 마지막으로 서버를 확인한 시각(ISO) */
  checkedAt?: string;
  /** 자동 받기·자동 설치 설정(옛 데몬은 없어요) */
  auto?: Mk42UpdateAuto;
}

/** 백그라운드 작업(워크플로우·서브에이전트) 상태. stale = 끝났다는 기록 없이 한동안 움직임이 없음(끊김·중단) */
export type BackgroundTaskStatus = 'running' | 'done' | 'failed' | 'stale';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** input + output + cacheRead + cacheCreation (Codex는 tokens_used 하나라 total만) */
  total: number;
}

/** 서브에이전트 하나(Claude Task·워크플로우 agent, Codex 하위 스레드) */
export interface BackgroundAgent {
  /** Claude agentId / Codex 하위 threadId */
  id: string;
  /** 워크플로우 label · 서브에이전트 설명 · Codex 별명(+제목) */
  label: string;
  /** Claude agentType(Explore·general-purpose…) / Codex agent_role */
  kind?: string;
  /** 워크플로우 단계 */
  phase?: string;
  status: BackgroundTaskStatus;
  /** ISO-8601 */
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
  tokens?: TokenUsage;
  /** 마지막 활동 한 줄 — 도구 이름 + 파일 이름 정도(명령 전문·대화 본문은 넣지 않아요) */
  activity?: string;
  /** 결과 요약 앞 300자(워크플로우 result.summary 등, 있을 때만) */
  summary?: string;
}

/** Claude Code 워크플로우 실행 하나 */
export interface BackgroundWorkflow {
  /** wf_… */
  runId: string;
  name?: string;
  description?: string;
  /** 스크립트 meta.phases 순서 + 단계별 시작·끝난 agent 수 */
  phases: { title: string; started: number; done: number }[];
  agents: BackgroundAgent[];
  status: BackgroundTaskStatus;
  startedAt?: string;
  updatedAt: string;
  /** 지금까지 시작한 agent 중 끝난 수 (전체 수는 실행 중에 늘 수 있어요) */
  progress: { done: number; total: number };
  tokens: TokenUsage;
}

/** 세션 하나의 백그라운드 작업 */
export interface SessionTasks {
  agent: AgentKind;
  sessionId: string;
  /** 정규화 경로 */
  cwd: string;
  title?: string;
  workflows: BackgroundWorkflow[];
  /** 워크플로우 밖 서브에이전트(Claude Task 도구) / Codex 하위 스레드 */
  subagents: BackgroundAgent[];
  /** 실행 중인 agent 수(워크플로우 포함) */
  running: number;
  tokens: TokenUsage;
  updatedAt: string;
}
