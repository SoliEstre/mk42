// 에이전트 창 동작: agent.openSession 처리(열기 → 설정 명령 → 재개 프롬프트, D11 채우기+전송), 세션 묶기, 스모크.
import { randomBytes } from 'node:crypto';
import { readdir, open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { AgentKind, AgentOpenSessionParams } from '@mark42/protocol';
import { claudeConfigDir } from '@mark42/protocol/paths';
import { sleep, type AgentAdapter, type FillResult } from './agents.ts';
import type { ClaudeSessionBinder } from './claudeSessions.ts';
import type { DaemonClient } from './daemonClient.ts';
import { planAgentSteps, type PromptStep } from './lib/agentPlan.ts';
import { agentOfRole, resolveFolderPath, type HostEnv, type RoleConfig } from './lib/role.ts';
import {
  SMOKE_MARKER_PREFIX,
  gateSend,
  isSmokeRecord,
  smokeKey,
  smokePrompt,
  smokeRequestId,
  type SmokeRecord,
} from './lib/smoke.ts';
import { t } from './l10n.ts';
import type { Logger } from './log.ts';
import type { OsKeySender } from './sender.ts';

/** 패널이 열리고 웹뷰가 입력을 받을 때까지 기다리는 시간(실측으로 조정) */
const FIRST_OPEN_SETTLE_MS = 2_500;
/** 창이 막 떴을 때는 에이전트 웹뷰가 처음 만들어져서 더 기다려요 */
const COLD_START_EXTRA_MS = 4_000;
const COLD_START_WINDOW_MS = 30_000;
const FOCUS_WAIT_MS = 10_000;
/** 작업 영역 신뢰를 막 허용했거나 창이 막 떴으면 에이전트 확장이 늦게 나타나요 */
const EXTENSION_WAIT_MS = 15_000;
const FILL_SETTLE_MS = 1_200;

/** `installed()`가 참이 될 때까지(확장 목록이 바뀔 때마다 확인) 최대 `ms` 기다려요 */
export function waitForExtension(installed: () => boolean, ms: number): Promise<boolean> {
  if (installed()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      sub.dispose();
      clearTimeout(timer);
      resolve(v);
    };
    const sub = vscode.extensions.onDidChange(() => {
      if (installed()) done(true);
    });
    const timer = setTimeout(() => done(installed()), ms);
  });
}
const AFTER_SETTING_SEND_MS = 2_500;
const BIND_AFTER_SEND_TIMEOUT_MS = 60_000;
const BIND_FILL_ONLY_TIMEOUT_MS = 30 * 60_000;

export interface AgentControllerDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  adapters: Record<AgentKind, AgentAdapter>;
  sender: OsKeySender;
  binder: ClaudeSessionBinder;
  daemon: DaemonClient;
  config: () => RoleConfig;
  hostEnv: () => HostEnv;
  /** 세션 ID를 알게 됐을 때(다음 hello에 넣고 세션 탭 갱신) */
  onBound: (agent: AgentKind, sessionId: string) => void;
  /** 에이전트 확장이 나타나길 기다리는 시간(기본 15초, 시험에서 줄여요) */
  extensionWaitMs?: number;
}

interface Outcome {
  ok: boolean;
  detail: string;
}

export class AgentController {
  #d: AgentControllerDeps;
  #queue: Promise<void> = Promise.resolve();
  #activatedAt = Date.now();
  #sessionId: string | undefined;

  constructor(deps: AgentControllerDeps) {
    this.#d = deps;
  }

  #settleMs(): number {
    return FIRST_OPEN_SETTLE_MS + (Date.now() - this.#activatedAt < COLD_START_WINDOW_MS ? COLD_START_EXTRA_MS : 0);
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  getSmoke(adapter: AgentAdapter): SmokeRecord | undefined {
    const v = adapter.version();
    if (!v) return undefined;
    const r = this.#d.context.globalState.get<unknown>(smokeKey(adapter.extensionId, v));
    return isSmokeRecord(r) ? r : undefined;
  }

  #bind(agent: AgentKind, sessionId: string): void {
    if (this.#sessionId === sessionId) return;
    this.#sessionId = sessionId;
    this.#d.daemon.api?.notify('window.sessionBound', { agent, sessionId });
    this.#d.onBound(agent, sessionId);
  }

  /** 데몬 알림 agent.openSession — 맞는 역할 창에서만, 한 번에 하나씩 */
  handleOpenSession(p: AgentOpenSessionParams, report = true): Promise<void> {
    const run = async () => {
      let out: Outcome;
      try {
        out = await this.#openSession(p);
      } catch (e) {
        out = { ok: false, detail: `error: ${e instanceof Error ? e.message : String(e)}` };
      }
      this.#d.log.info(`openSession ${p.requestId} ok=${out.ok} ${out.detail}`);
      if (report) {
        try {
          await this.#d.daemon.api?.request('window.reportResult', { requestId: p.requestId, ok: out.ok, detail: out.detail });
        } catch (e) {
          this.#d.log.warn(`reportResult failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #openSession(p: AgentOpenSessionParams): Promise<Outcome> {
    const cfg = this.#d.config();
    const myAgent = agentOfRole(cfg.role);
    if (myAgent !== p.agent) return { ok: false, detail: `role mismatch (${cfg.role ?? 'unmanaged'} vs ${p.agent})` };
    const adapter = this.#d.adapters[p.agent];
    if (!(await waitForExtension(() => adapter.installed(), this.#d.extensionWaitMs ?? EXTENSION_WAIT_MS)))
      return { ok: false, detail: `${adapter.extensionId} not installed` };
    const folderPath = resolveFolderPath(cfg, this.#d.hostEnv());
    const sessionId = p.sessionId;
    const newSession = sessionId === undefined;

    // 막 뜬 창은 포커스가 늦게 올 수 있어요 — 보낼 생각일 때만 잠깐 기다려요
    if (p.autoSend && cfg.autoSend && cfg.sender !== 'none') await waitForFocus(FOCUS_WAIT_MS);
    const gate = gateSend({
      requested: p.autoSend,
      settingEnabled: cfg.autoSend,
      sender: cfg.sender,
      smoke: this.getSmoke(adapter),
      windowFocused: vscode.window.state.focused,
    });
    const plan = planAgentSteps({ agent: p.agent, settings: p.settings, prompt: p.prompt, newSession, sendAllowed: gate.send });
    const notes: string[] = [gate.send ? 'send' : `fill-only(${gate.reason})`];
    if (plan.skipped.length) notes.push(`skipped ${plan.skipped.join(', ')}`);

    if (sessionId !== undefined) this.#bind(p.agent, sessionId);

    if (p.agent === 'codex') return this.#openCodex(adapter, sessionId, plan.steps, gate.send, notes);

    // Claude
    const exclude = newSession ? await this.#d.binder.snapshotIds() : new Set<string>();
    const openedAt = Date.now();
    let current = sessionId;
    const steps = plan.steps;
    if (steps.length === 0) {
      await adapter.open(sessionId, undefined);
      if (newSession && folderPath) this.#watchBinding(folderPath, openedAt, exclude, BIND_FILL_ONLY_TIMEOUT_MS);
      return { ok: true, detail: notes.concat('opened').join('; ') };
    }
    let sent = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      let f: FillResult;
      if (i === 0) {
        f = await adapter.open(current, step.text);
        if (f.detail) notes.push(f.detail);
        await sleep(this.#settleMs());
      } else {
        if (current === undefined) {
          // 새 세션: 첫 전송 뒤 세션 ID를 알아야 같은 세션에 이어서 채울 수 있어요
          if (!folderPath) return { ok: false, detail: notes.concat('no folder for session binding').join('; ') };
          current = await this.#d.binder.waitForNewSession({ folderPath, openedAt, excludeSessionIds: exclude, timeoutMs: BIND_AFTER_SEND_TIMEOUT_MS });
          if (current === undefined) return { ok: false, detail: notes.concat(`sent ${sent}/${steps.length}; session id unknown`).join('; ') };
          this.#bind('claude', current);
        }
        f = await adapter.fill(current, step.text);
        if (f.detail && f.sendable === false) notes.push(f.detail);
        await sleep(FILL_SETTLE_MS);
      }
      if (!step.send) continue;
      // 채운 곳이 send()가 포커스하는 사이드바 입력창이 아니면 Enter를 치지 않아요(엉뚱한 입력창 제출 방지)
      if (f.sendable === false) {
        return { ok: false, detail: notes.concat(`sent ${sent}/${steps.length}; filled but not sent (input location unknown)`).join('; ') };
      }
      if (!vscode.window.state.focused) return { ok: false, detail: notes.concat(`sent ${sent}/${steps.length}; window lost focus`).join('; ') };
      const r = await adapter.send(this.#d.sender, undefined);
      if (!r.ok) return { ok: false, detail: notes.concat(`sent ${sent}/${steps.length}; ${r.detail}`).join('; ') };
      sent++;
      if (step.isSetting) await sleep(AFTER_SETTING_SEND_MS);
    }
    if (newSession && current === undefined && folderPath) {
      this.#watchBinding(folderPath, openedAt, exclude, sent > 0 ? BIND_AFTER_SEND_TIMEOUT_MS * 5 : BIND_FILL_ONLY_TIMEOUT_MS);
    }
    return { ok: true, detail: notes.concat(`steps ${steps.length}, sent ${sent}`).join('; ') };
  }

  async #openCodex(
    adapter: AgentAdapter,
    threadId: string | undefined,
    steps: PromptStep[],
    sendAllowed: boolean,
    notes: string[],
  ): Promise<Outcome> {
    await adapter.open(threadId, undefined);
    // TODO(Codex 새 스레드 묶기): 스레드 ID를 창에서 알 공식 경로가 없어요. 데몬 app-server(thread/list cwd·최신)로 묶는 쪽이 맞아요.
    if (threadId === undefined) notes.push('codex new thread not bound');
    const prompt = steps.find((s) => !s.isSetting)?.text;
    if (!prompt) return { ok: true, detail: notes.concat('opened').join('; ') };
    if (!sendAllowed) {
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage(vscode.l10n.t('Codex has no official way to fill its input box, so the resume prompt was copied to the clipboard. Paste it and send.'));
      return { ok: true, detail: notes.concat('prompt copied to clipboard').join('; ') };
    }
    await sleep(this.#settleMs());
    if (!vscode.window.state.focused) return { ok: false, detail: notes.concat('window lost focus').join('; ') };
    const r = await adapter.send(this.#d.sender, prompt);
    return { ok: r.ok, detail: notes.concat(r.ok ? 'pasted+sent' : r.detail).join('; ') };
  }

  #watchBinding(folderPath: string, openedAt: number, exclude: Set<string>, timeoutMs: number): void {
    void this.#d.binder.waitForNewSession({ folderPath, openedAt, excludeSessionIds: exclude, timeoutMs }).then((id) => {
      if (id) this.#bind('claude', id);
      else this.#d.log.warn('claude session binding timed out');
    });
  }

  // ---- 스모크(D11) — 사용자가 직접 부를 때만, 새 임시 세션으로만

  async runSmoke(): Promise<void> {
    const cfg = this.#d.config();
    let agent = agentOfRole(cfg.role);
    if (!agent) {
      const picks = (['claude', 'codex'] as const)
        .filter((a) => this.#d.adapters[a].installed())
        .map((a) => ({ label: a === 'claude' ? 'Claude Code' : 'Codex', agent: a }));
      if (picks.length === 0) {
        void vscode.window.showWarningMessage(vscode.l10n.t('Neither the Claude Code nor the Codex extension is installed.'));
        return;
      }
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: vscode.l10n.t('Choose the extension to smoke-test') });
      if (!pick) return;
      agent = pick.agent;
    }
    const adapter = this.#d.adapters[agent];
    const version = adapter.version();
    if (!adapter.installed() || !version) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Could not find the {0} extension.', adapter.extensionId));
      return;
    }
    const startLabel = vscode.l10n.t('Start test');
    const go = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} {1} smoke test', adapter.extensionId, version),
      {
        modal: true,
        detail:
          vscode.l10n.t('Opens a new temporary session in this window and automatically sends a short test prompt. Existing sessions are not touched. Keep this window in front and do not touch the keyboard during the test.'),
      },
      startLabel,
    );
    if (go !== startLabel) return;
    const nonce = randomBytes(6).toString('hex');
    const prompt = smokePrompt(nonce, t);
    let result: { ok: boolean; detail: string };
    try {
      result = agent === 'claude' ? await this.#smokeClaude(adapter, prompt, nonce) : await this.#smokeCodex(adapter, prompt);
    } catch (e) {
      result = { ok: false, detail: `error: ${e instanceof Error ? e.message : String(e)}` };
    }
    const record: SmokeRecord = { ok: result.ok, at: new Date().toISOString(), sender: cfg.sender, detail: result.detail };
    await this.#d.context.globalState.update(smokeKey(adapter.extensionId, version), record);
    this.#d.log.info(`smoke ${adapter.extensionId}@${version} ok=${result.ok} ${result.detail}`);
    try {
      await this.#d.daemon.api?.request('window.reportResult', {
        requestId: smokeRequestId(adapter.extensionId, version),
        ok: result.ok,
        detail: result.detail,
      });
    } catch {
      // 데몬이 없어도 결과는 globalState에 남아요
    }
    if (result.ok) void vscode.window.showInformationMessage(vscode.l10n.t('Smoke test passed. Auto-send will be used with this version. ({0})', result.detail));
    else void vscode.window.showWarningMessage(vscode.l10n.t('Smoke test failed. With this version the prompt is only filled in. ({0})', result.detail));
  }

  async #smokeClaude(adapter: AgentAdapter, prompt: string, nonce: string): Promise<{ ok: boolean; detail: string }> {
    const folderPath = resolveFolderPath(this.#d.config(), this.#d.hostEnv());
    const exclude = await this.#d.binder.snapshotIds();
    const openedAt = Date.now();
    const f = await adapter.open(undefined, prompt);
    if (f.sendable === false) return { ok: false, detail: `filled but not sent: ${f.detail ?? 'input location unknown'}` };
    await sleep(this.#settleMs());
    if (!vscode.window.state.focused) return { ok: false, detail: 'window not focused' };
    const r = await adapter.send(this.#d.sender, undefined);
    if (!r.ok) return { ok: false, detail: r.detail };
    if (folderPath) {
      const sid = await this.#d.binder.waitForNewSession({ folderPath, openedAt, excludeSessionIds: exclude, timeoutMs: 45_000 });
      if (sid && (await transcriptHasMarker(sid, `${SMOKE_MARKER_PREFIX}${nonce}`))) return { ok: true, detail: `verified in transcript ${sid}` };
    }
    return askUser('Claude');
  }

  async #smokeCodex(adapter: AgentAdapter, prompt: string): Promise<{ ok: boolean; detail: string }> {
    await adapter.open(undefined, undefined);
    await sleep(this.#settleMs());
    if (!vscode.window.state.focused) return { ok: false, detail: 'window not focused' };
    const r = await adapter.send(this.#d.sender, prompt);
    if (!r.ok) return { ok: false, detail: r.detail };
    return askUser('Codex');
  }
}

function waitForFocus(ms: number): Promise<boolean> {
  if (vscode.window.state.focused) return Promise.resolve(true);
  return new Promise((resolve) => {
    const sub = vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused) return;
      clearTimeout(t);
      sub.dispose();
      resolve(true);
    });
    const t = setTimeout(() => {
      sub.dispose();
      resolve(false);
    }, ms);
  });
}

async function askUser(name: string): Promise<{ ok: boolean; detail: string }> {
  const sent = vscode.l10n.t('It was sent');
  const notSent = vscode.l10n.t('It was not sent');
  const a = await vscode.window.showInformationMessage(vscode.l10n.t('Was the test prompt sent in the {0} panel?', name), { modal: true }, sent, notSent);
  if (a === sent) return { ok: true, detail: 'confirmed by user' };
  return { ok: false, detail: a === notSent ? 'user reported not sent' : 'not confirmed' };
}

/** 스모크로 만든 임시 세션의 기록에 표식이 있는지만 봐요(앞 2MB, 내용은 로그에 남기지 않아요). */
async function transcriptHasMarker(sessionId: string, marker: string): Promise<boolean> {
  const projects = join(claudeConfigDir(), 'projects');
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return false;
  }
  for (const d of dirs) {
    const file = join(projects, d, `${sessionId}.jsonl`);
    let fh;
    try {
      fh = await openFile(file, 'r');
    } catch {
      continue;
    }
    try {
      const buf = Buffer.alloc(2 * 1024 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8').includes(marker);
    } finally {
      await fh.close();
    }
  }
  return false;
}
