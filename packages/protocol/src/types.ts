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
  /**
   * 이 창의 Mark42 확장이 처리하는 데몬 알림·기능(예: {@link CAPABILITY_QUIT_FOR_UPDATE}). 창은 연 뒤 다시 로드할 때까지 처음 읽은 확장으로 돌아서,
   * 데몬은 확장 판 대신 이 목록으로 옛 확장을 가려요(개발 경로 확장은 판이 늘 0.1.0). 옛 확장은 보내지 않아요
   */
  capabilities?: string[];
}

/** 창 기능: `app.quitForUpdate`를 받으면 앱을 끝내요(«다시 시작해서 적용», 2026-11-17 확장부터) */
export const CAPABILITY_QUIT_FOR_UPDATE = 'app.quitForUpdate';

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
  /**
   * «다시 시작해서 적용»(교훈 012) — 더 새 Mk42 앱 판이 깔렸는데 같은 프로필의 열린 Mk42 창은 아직 옛 판 main에서 돌아요. 새 창도 옛 판으로
   * 열려요(다른 판이면 두 번째 main이 돼 웹뷰가 모두 깨져요). 창이 확인을 받은 뒤 app.restartToUpdate를 불러요. 해당 없음·옛 데몬이면 없어요.
   * running = 옛 판(붙어 있는 옛 판 창 중 가장 높은 판), available = 다시 시작하면 쓸 가장 새 판(둘 다 앱 판, 예: 1.146.0 — 패키지 판 current와 달라요).
   * restarting = 데몬이 옛 창을 닫고 옛 main이 끝나기(파이프와 그 판 설치 폴더의 프로세스가 모두 사라지기)를 기다리는 중 — 그동안 판을 정하지 않은 Mk42
   * 창 띄우기는 거절돼요. failed = 지난 다시 시작이 멈춘 이유(timeout: 옛 main이 제한 시간 안에 끝나지 않았어요 — 저장 확인·실행 중인 작업을 묻는 창이
   * 남았거나 그 창의 Mark42 확장이 옛 판일 수 있어요. 데몬은 아무것도 강제로 끄지 않아요. 이미 닫힌 창은 아직 떠 있는 옛 main으로 다시 열고, 남은 창은
   * 옛 main이 끝나면(최대 30분 지켜봐요) 새 판으로 다시 열어요), error = 그 한 줄(영어).
   * needsReload = 이 옛 판들의 붙은 창이 모두 app.quitForUpdate를 모르는 옛 Mark42 확장이에요(WindowInfo.capabilities) — 다시 시작을 시작하지 않아요.
   * 그 창 하나를 다시 로드하거나 직접 닫으라고 안내해요.
   */
  appRestart?: { running: string; available: string; restarting?: boolean; failed?: 'timeout'; error?: string; needsReload?: string[] };
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
  /** 마지막 응답의 모델 id(claude-opus-5-5 · gpt-6-luna) — 옛 데몬·기록에 없으면 없음 */
  model?: string;
  /** 추론 강도(low·medium·high·xhigh·max) */
  effort?: string;
}

/** 명령으로 띄우는 에이전트 CLI(데몬이 명령어 자리만 보고 판별 — tasks/agentCli.ts) */
export type AgentCli = 'claude' | 'codex' | 'grok' | 'agy';
export const AGENT_CLIS: readonly AgentCli[] = ['claude', 'codex', 'grok', 'agy'];

/** 명령 하나 안의 에이전트 CLI 호출 하나(일을 시키는 호출만 — --help·--version·models 같은 확인 호출은 빼요). 값은 허용 목록 모양만 */
export interface AgentCliCall {
  cli: AgentCli;
  /** 명령에 준 모델(없으면 그 CLI 기본값 — 데몬은 다른 도구의 설정 파일을 읽지 않아요) */
  model?: string;
  effort?: string;
}

/** 세션이 띄운 터미널 명령 하나(Claude Bash·PowerShell 도구) — 명령 전문은 싣지 않고 모델이 붙인 설명만 */
export interface BackgroundRun {
  /** 도구 호출 id(toolu_…) */
  id: string;
  /** 명령에 붙은 설명(description). 없으면 도구 이름 */
  label: string;
  /** Bash · PowerShell */
  tool: string;
  /** 백그라운드 실행(run_in_background 또는 도중에 백그라운드로 넘어감) */
  background: boolean;
  /** 백그라운드 작업 id(끝남 알림과 맞춰요) */
  taskId?: string;
  status: BackgroundTaskStatus;
  /** ISO-8601 */
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  /**
   * 이 명령이 띄운 에이전트 CLI 호출(명령 하나 = 블록 하나, 호출마다 뱃지). 있으면 «작업»의 에이전트 CLI 블록이고 «실행»에서는 빠져요.
   * 옛 확장은 이 필드를 몰라 «실행»에 그대로 보여요.
   */
  calls?: AgentCliCall[];
  /** 서브에이전트·워크플로우 agent가 띄운 명령이면 그 agent(본 세션이 띄웠으면 없음) */
  origin?: { agentId: string; label?: string; runId?: string };
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
  /** 터미널 명령(Claude만, 실행 중 먼저 — 옛 데몬은 없음) */
  runs?: BackgroundRun[];
  /** 실행 중인 agent 수(워크플로우 포함 — 터미널 명령은 세지 않아요. 에이전트 CLI 블록도 여기엔 없어요 → cliRunning) */
  running: number;
  /** 실행 중인 에이전트 CLI 블록 수(runs 중 calls 있는 것 — 옛 데몬은 없음). 새 확장·통합 창은 running + cliRunning을 실행 중으로 봐요 */
  cliRunning?: number;
  tokens: TokenUsage;
  updatedAt: string;
}
