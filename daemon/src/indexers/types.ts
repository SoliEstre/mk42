// 세션 인덱서 인터페이스 — 데몬 코어(daemon/src)와 인덱서(daemon/src/indexers)의 경계예요.
import type { AgentKind, SessionStatus, SessionSummary } from '@mark42/protocol';

export interface ListOptions {
  /** 정규화 경로. 없으면 전체 */
  cwd?: string;
  includeSubagents?: boolean;
  limit?: number;
}

export interface LiveSession {
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  /** 그 세션을 돌리는 프로세스 pid (Claude: sessions/<pid>.json) */
  pid?: number;
  /** Codex: 스레드 owner 추정 (확장 창 / Desktop 앱 / CLI) */
  owner?: string;
}

export interface SessionIndexer {
  readonly agent: AgentKind;
  /** 최근 순(updatedAt 내림차순) */
  list(opts: ListOptions): Promise<SessionSummary[]>;
  /** 지금 살아 있는 세션 (재개 전 중복 확인, D11·R12) */
  live(): Promise<LiveSession[]>;
  /** 변경 감시 시작 — 바뀌면 onChange (호출 측에서 디바운스) */
  start(onChange: () => void): Promise<void>;
  stop(): Promise<void>;
}
