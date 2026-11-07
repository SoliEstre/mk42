// D11 스모크 상태 — 확장 버전별로 «Enter 자동 전송이 통하는지» 기록하고, 실패한 버전에서는 채우기만 해요.
import { sourceText, type Translate } from './l10n.ts';

export type SenderKind = 'osKeys' | 'none';

export interface SmokeRecord {
  ok: boolean;
  /** ISO-8601 */
  at: string;
  sender: SenderKind;
  detail?: string;
}

export const SMOKE_KEY_PREFIX = 'mark42.smoke:';

/** globalState 키 — 확장 ID + 버전 (`mark42.smoke:anthropic.claude-code@2.1.301`) */
export function smokeKey(extensionId: string, version: string): string {
  return `${SMOKE_KEY_PREFIX}${extensionId.toLowerCase()}@${version}`;
}

export function smokeRequestId(extensionId: string, version: string): string {
  return `smoke:${extensionId.toLowerCase()}@${version}`;
}

export function isSmokeRecord(v: unknown): v is SmokeRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<SmokeRecord>;
  return typeof r.ok === 'boolean' && typeof r.at === 'string' && (r.sender === 'osKeys' || r.sender === 'none');
}

export interface SendGateInput {
  /** 요청(고정 세션·설정)의 autoSend */
  requested: boolean;
  /** mark42.autoSend 설정 */
  settingEnabled: boolean;
  /** mark42.sender 설정 */
  sender: SenderKind;
  /** 이 확장 버전의 마지막 스모크 결과 */
  smoke: SmokeRecord | undefined;
  /** 창이 포커스돼 있는지 — OS 키 입력은 전경 창으로 가요 */
  windowFocused: boolean;
}

export type SendGate =
  | { send: true; sender: 'osKeys' }
  | { send: false; reason: 'not-requested' | 'disabled' | 'sender-none' | 'smoke-failed' | 'not-focused' };

/**
 * 전송 여부. 스모크를 아직 안 돌린 버전은 보내 봐요(D11: «실패하면 채우기만»).
 * 창이 포커스가 아니면 다른 앱에 Enter가 갈 수 있어서 보내지 않아요.
 */
export function gateSend(i: SendGateInput): SendGate {
  if (!i.requested) return { send: false, reason: 'not-requested' };
  if (!i.settingEnabled) return { send: false, reason: 'disabled' };
  if (i.sender === 'none') return { send: false, reason: 'sender-none' };
  if (i.smoke && !i.smoke.ok) return { send: false, reason: 'smoke-failed' };
  if (!i.windowFocused) return { send: false, reason: 'not-focused' };
  return { send: true, sender: 'osKeys' };
}

export const SMOKE_MARKER_PREFIX = 'm42-smoke-';

export function smokePrompt(nonce: string, tr: Translate = sourceText): string {
  return `${tr('This is a Mark42 smoke test. Do not use any tools; just reply OK.')} [${SMOKE_MARKER_PREFIX}${nonce}]`;
}
