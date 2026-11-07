// agent.openSession → «채울 텍스트 + 전송 여부» 단계 목록. 설정 복원은 패널에 입력하는 슬래시 명령이에요(보고서 4.4).
import type { AgentKind, AgentSettings, ClaudeSettings } from '@mark42/protocol';

export interface PromptStep {
  text: string;
  send: boolean;
  /** 설정 명령인지(로그·보고용) */
  isSetting: boolean;
}

export interface AgentPlan {
  steps: PromptStep[];
  /** 전송이 막혀 적용하지 못한 설정 명령 */
  skipped: string[];
}

const CLAUDE_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_RE = /^[A-Za-z0-9._:\-[\]]{1,80}$/;

/**
 * Claude 설정 → 슬래시 명령.
 * - ultracode: `/effort ultracode` (xhigh도 함께 켜져서 effort 명령은 따로 보내지 않아요)
 * - effort: `/effort <단계>`
 * - model: 재개 때는 대화 기록의 모델이 복원돼서 새 세션일 때만 `/model <id>`
 */
export function claudeSettingCommands(settings: AgentSettings | undefined, newSession: boolean): string[] {
  if (!settings) return [];
  const s = settings as ClaudeSettings;
  const out: string[] = [];
  if (newSession && typeof s.model === 'string' && MODEL_RE.test(s.model)) out.push(`/model ${s.model}`);
  if (s.ultracode === true) out.push('/effort ultracode');
  else if (typeof s.effort === 'string' && CLAUDE_EFFORTS.has(s.effort)) out.push(`/effort ${s.effort}`);
  return out;
}

export function planAgentSteps(input: {
  agent: AgentKind;
  settings?: AgentSettings | undefined;
  prompt?: string | undefined;
  newSession: boolean;
  sendAllowed: boolean;
}): AgentPlan {
  // Codex 스레드 설정(model·effort·approval·sandbox)은 app-server가 스레드별로 저장·복원해요(보고서 5.3) — 창에서는 건드리지 않아요.
  const commands = input.agent === 'claude' ? claudeSettingCommands(input.settings, input.newSession) : [];
  const prompt = typeof input.prompt === 'string' && input.prompt.trim().length > 0 ? input.prompt : undefined;
  if (!input.sendAllowed) {
    // 채우기만: 입력창은 하나라서 재개 프롬프트만 채우고 설정 명령은 건너뛰어요
    return { steps: prompt ? [{ text: prompt, send: false, isSetting: false }] : [], skipped: commands };
  }
  const steps: PromptStep[] = commands.map((text) => ({ text, send: true, isSetting: true }));
  if (prompt) steps.push({ text: prompt, send: true, isSetting: false });
  return { steps, skipped: [] };
}
