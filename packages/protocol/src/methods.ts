// mk42d 로컬 IPC 메서드(창·통합 창 ↔ 데몬, NDJSON JSON-RPC 2.0)
import type {
  AgentExtensionUpdate,
  AgentKind,
  SessionTasks,
  AgentSettings,
  Folder,
  LinkKind,
  Mk42UpdateAuto,
  Mk42UpdateStatus,
  PinnedDefaults,
  PinnedSession,
  SessionSummary,
  WindowInfo,
  WindowRole,
} from './types.ts';
import type { HubTheme } from './theme.ts';

export const PROTOCOL_VERSION = 1;

export interface HelloParams {
  protocolVersion: number;
  window: WindowInfo;
  /** 서버 인증용 challenge — base64url(32 랜덤 바이트). 있으면 데몬이 proof로 답해요(@mark42/protocol/auth). */
  challenge?: string;
}
export interface HelloResult {
  protocolVersion: number;
  daemonVersion: string;
  windowId: string;
  /** base64url(HMAC-SHA256(<home>/auth.secret, "m42d-hello-v1" LF 파이프 이름(canonical) LF challenge)) — challenge가 있을 때만 */
  proof?: string;
}

/** `$/auth` — 창 등록 없이 서버 인증만(관리하지 않는 창, 데몬 두 번째 실행). proof 식은 HelloResult.proof와 같아요. */
export interface AuthParams {
  challenge: string;
}
export interface AuthResult {
  proof: string;
}

export interface SessionsListParams {
  folderId?: string;
  cwd?: string;
  agent?: AgentKind;
  includeSubagents?: boolean;
  limit?: number;
}

export interface WindowOpenParams {
  folderPath: string;
  role: WindowRole;
  sessionId?: string;
  newSession?: boolean;
}
export interface WindowOpenResult {
  status: 'focused' | 'launched';
  windowId?: string;
  slotId?: string;
}

export interface Selection {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface EditorRouteParams {
  folderPath: string;
  uri: string;
  selection?: Selection;
  kind: LinkKind;
}
export interface EditorRouteResult {
  status: 'forwarded' | 'launched';
}

export interface AutostartState {
  enabled: boolean;
  method: 'taskScheduler';
  taskName: string;
}

export type Empty = Record<string, never>;

/** 확장(창) → 데몬 요청 */
export interface RequestMap {
  hello: { params: HelloParams; result: HelloResult };
  '$/auth': { params: AuthParams; result: AuthResult };
  'folders.list': { params: Empty; result: Folder[] };
  'folders.add': { params: { path: string; label?: string }; result: Folder };
  /** git 저장소를 parentDir 아래 새 폴더로 클론하고 등록해요(통합 창 «폴더 등록» 칸에 주소). 오래 걸려요 — 요청 시간을 넉넉히 */
  'folders.clone': { params: { url: string; parentDir: string; label?: string }; result: Folder };
  'folders.remove': { params: { folderId: string }; result: Empty };
  'sessions.list': { params: SessionsListParams; result: SessionSummary[] };
  'windows.list': { params: Empty; result: WindowInfo[] };
  'window.open': { params: WindowOpenParams; result: WindowOpenResult };
  'editor.route': { params: EditorRouteParams; result: EditorRouteResult };
  'pinned.list': { params: Empty; result: PinnedSession[] };
  /** resumePrompt·autoSend를 빼면 새 항목은 판 기본값(pinned.defaults), 있던 항목은 그대로 */
  'pinned.upsert': {
    params: Omit<PinnedSession, 'id' | 'resumePrompt' | 'autoSend'> & { id?: string; resumePrompt?: string; autoSend?: boolean };
    result: PinnedSession;
  };
  'pinned.defaults': { params: Empty; result: PinnedDefaults };
  'pinned.remove': { params: { pinnedId: string }; result: Empty };
  'autostart.get': { params: Empty; result: AutostartState };
  'autostart.set': { params: { enabled: boolean }; result: AutostartState };
  'resume.runNow': { params: { pinnedIds?: string[] }; result: { started: string[] } };
  'window.reportResult': { params: { requestId: string; ok: boolean; detail?: string }; result: Empty };
  /** 가장 최근에 포커스된 Mark42 창의 테마(별도 통합 창이 화면 색을 맞춰요). 아직 없으면 theme 없음 */
  'theme.get': { params: Empty; result: { theme?: HubTheme } };
  /** 데몬이 맡는 에이전트 확장(D10 Codex)의 새 버전을 지금 확인하고 있으면 Mk42 확장 폴더에 깔아요(떠 있는 창은 «확장 다시 로드» 때). 받기가 길어요 — 요청 시간을 넉넉히 */
  'extensions.checkUpdates': { params: { ids?: string[] }; result: { updates: AgentExtensionUpdate[] } };
  /** 마지막으로 확인한 상태(네트워크 없이) — 창이 단추 모양을 맞출 때 */
  'extensions.status': { params: { ids?: string[] }; result: { updates: AgentExtensionUpdate[] } };
  /**
   * 검증되지 않은 새 버전(status pending)을 사용자가 위험을 감수하고 깔아요 — 그 버전이 지금 기다리는 버전일 때만.
   * 공식 판과 달랐던(blocked) 버전은 깔지 않아요.
   */
  'extensions.installUnverified': { params: { id: string; version: string }; result: AgentExtensionUpdate };
  /**
   * 백그라운드 작업(워크플로우·서브에이전트) — 최근 세션별, 실행 중인 세션이 먼저. sessionId를 주면 그 세션만.
   * 바뀌면 state.changed {topics:['tasks']}.
   */
  'tasks.list': { params: TasksListParams; result: SessionTasks[] };
  /** Mk42 자체 업데이트(계약 C4) — 마지막 상태(네트워크 없이) */
  'update.status': { params: Empty; result: Mk42UpdateStatus };
  /** 지금 서버를 확인해요. 서명 확인까지 기다리고, 새 판 받기는 이어서 백그라운드로(state downloading → ready, update.changed) */
  'update.check': { params: Empty; result: Mk42UpdateStatus };
  /** 받아 둔(ready) 설치 파일을 sha256을 다시 맞춘 뒤 조용한 설치로 띄워요. 설치 엔진이 이 데몬을 껐다 새 판으로 띄워요(창은 그대로) */
  'update.install': { params: Empty; result: Mk42UpdateInstallResult };
  /** 자동 받기가 꺼져 있어 기다리는 새 판(available)을 지금 받아요 — 서명을 다시 확인한 뒤 받기는 백그라운드로(downloading → ready) */
  'update.download': { params: Empty; result: Mk42UpdateStatus };
  /** 자동 받기·자동 설치 설정을 바꿔요(registry.json settings.update). 자동 받기를 켤 때 available이면 바로 받아요 */
  'update.setAuto': { params: Partial<Mk42UpdateAuto>; result: Mk42UpdateStatus };
}

export interface Mk42UpdateInstallResult {
  started: boolean;
  error?: string;
}

/** `update.changed` — announce는 데몬이 고른 창 하나에만(가장 최근 포커스, 없으면 처음 붙는 창). 그 창이 «지금 설치할까요?»를 물어요 */
export type Mk42UpdateChanged = Mk42UpdateStatus & { announce?: boolean };

export interface TasksListParams {
  agent?: AgentKind;
  sessionId?: string;
  /** 이 시간 안에 움직인 세션만(기본 12시간) */
  sinceMs?: number;
  /** 세션 수 상한(기본 30) */
  limit?: number;
}
export type RequestMethod = keyof RequestMap;
export type ParamsOf<M extends RequestMethod> = RequestMap[M]['params'];
export type ResultOf<M extends RequestMethod> = RequestMap[M]['result'];

export interface AgentOpenSessionParams {
  requestId: string;
  agent: AgentKind;
  sessionId?: string;
  newSession?: boolean;
  settings?: AgentSettings;
  prompt?: string;
  autoSend: boolean;
}

export type StateTopic = 'folders' | 'sessions' | 'windows' | 'pinned' | 'theme' | 'tasks';

/** 데몬 → 창 알림 */
export interface DaemonNotificationMap {
  'agent.openSession': AgentOpenSessionParams;
  'editor.openUri': { uri: string; selection?: Selection; kind: LinkKind };
  'state.changed': { topics: StateTopic[] };
  /** Mk42 확장 폴더에 에이전트 확장 새 버전이 깔렸어요(데몬 업데이트) — 창은 다시 살펴 «업데이트 적용»을 보여요 */
  'extensions.updated': { ids: string[] };
  /** Mk42 자체 업데이트 상태가 바뀌었어요(확인·받기 진행·ready·설치 시작·오류) — 붙은 창 모두 + 통합 창 */
  'update.changed': Mk42UpdateChanged;
}
export type DaemonNotification = keyof DaemonNotificationMap;

/** 창 → 데몬 알림 */
export interface WindowNotificationMap {
  'window.status': { focused?: boolean; theme?: string };
  'window.sessionBound': { agent: AgentKind; sessionId: string };
  /** 이 창의 테마 색(창이 붙을 때·테마를 바꿀 때·포커스를 받을 때) */
  'window.theme': HubTheme;
}
export type WindowNotification = keyof WindowNotificationMap;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ProtocolMismatch: -32001,
  NotFound: -32002,
  InvalidPath: -32003,
  LaunchFailed: -32004,
  SessionBusy: -32005,
  Timeout: -32006,
  /** folders.clone: git clone이 실패했어요(메시지에 git의 마지막 오류 줄) */
  CloneFailed: -32007,
} as const;
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
