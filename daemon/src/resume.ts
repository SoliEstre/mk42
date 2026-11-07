// 고정 세션 재개 (WBS 3.2) + 부팅 재개 모드 골격 (WBS 3.6, D28).
import { execFile } from 'node:child_process';
import {
  AGENT_ROLES,
  type AgentKind,
  type AgentSettings,
  type PinnedSession,
  type ResumeMode,
  type WindowOpenParams,
  type WindowOpenResult,
} from '@mark42/protocol';
import type { LiveSession } from './indexers/types.ts';
import { errMsg, type Logger } from './log.ts';

/** window.open에 덧붙이는 재개 정보 → agent.openSession 알림으로 가요. */
export interface OpenExtra {
  settings?: AgentSettings;
  prompt?: string;
  autoSend?: boolean;
}

/** openWindow 내부 결과 — agent.openSession을 보냈거나 대기열에 넣었으면 그 requestId */
export type OpenOutcome = WindowOpenResult & { requestId?: string };

export interface ResumeResultReport {
  ok: boolean;
  detail?: string;
}

export interface ResumeDeps {
  pinned(): readonly PinnedSession[];
  /** 그 에이전트의 살아 있는 세션 (인덱서 live()) */
  live(agent: AgentKind): Promise<LiveSession[]>;
  /** 연결된 Mark42 에이전트 창이 이미 그 세션을 들고 있는지 (Codex live()는 다른 프로세스 스레드를 못 봐요) */
  held?(agent: AgentKind, sessionId: string): boolean;
  open(params: WindowOpenParams, extra: OpenExtra): Promise<OpenOutcome>;
  /**
   * 그 창의 window.reportResult를 기다려요(시간 초과면 undefined).
   * 자동 전송은 전경 포커스가 필요해서(D11), 한 창이 보내기를 끝낸 뒤 다음 창을 띄워요.
   */
  waitResult?(requestId: string, timeoutMs: number): Promise<ResumeResultReport | undefined>;
  /** 기본 120초 */
  resultTimeoutMs?: number;
  log?: Logger;
  /** 창 사이 간격 — 한꺼번에 띄우면 메인 프로세스·확장 호스트가 몰려요 */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ResumeSkip {
  id: string;
  reason: 'alive' | 'not-found' | 'live-check-failed' | 'launch-failed';
  detail?: string;
}
export interface ResumeOutcome {
  started: string[];
  skipped: ResumeSkip[];
}

export interface ResumeRun {
  /** 사전 확인(살아 있음·창이 들고 있음)을 통과해 열 차례인 항목 */
  planned: Promise<string[]>;
  /** 전부 끝났을 때(창마다 보고를 기다린 뒤) */
  done: Promise<ResumeOutcome>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * pinnedIds가 있으면 그 항목만(enabled 무시, 수동 실행), 없으면 enabled 항목 전부. order 오름차순.
 * 이미 살아 있는 세션·Mark42 창이 들고 있는 세션은 건너뛰어요(두 곳에서 열면 메시지가 섞여요, 보고서 4.5).
 * 창은 하나씩: 자동 전송이면 그 창의 결과 보고를 기다린 뒤 다음 창을 띄워요.
 */
export function startResume(deps: ResumeDeps, pinnedIds?: string[]): ResumeRun {
  let resolvePlanned: (ids: string[]) => void = () => undefined;
  const planned = new Promise<string[]>((r) => {
    resolvePlanned = r;
  });
  const done = (async (): Promise<ResumeOutcome> => {
    const all = [...deps.pinned()].sort((a, b) => a.order - b.order);
    const out: ResumeOutcome = { started: [], skipped: [] };
    let targets: PinnedSession[];
    if (pinnedIds) {
      const wanted = new Set(pinnedIds);
      targets = all.filter((p) => wanted.has(p.id));
      for (const id of pinnedIds) if (!all.some((p) => p.id === id)) out.skipped.push({ id, reason: 'not-found' });
    } else {
      targets = all.filter((p) => p.enabled);
    }
    const liveCache = new Map<AgentKind, Promise<LiveSession[]>>();
    const liveOf = (agent: AgentKind) => {
      let p = liveCache.get(agent);
      if (!p) {
        p = deps.live(agent);
        liveCache.set(agent, p);
      }
      return p;
    };
    const go: PinnedSession[] = [];
    for (const pin of targets) {
      let live: LiveSession[];
      try {
        live = await liveOf(pin.agent);
      } catch (e) {
        deps.log?.warn(`resume ${pin.id}: live check failed: ${errMsg(e)}`);
        out.skipped.push({ id: pin.id, reason: 'live-check-failed', detail: errMsg(e) });
        continue;
      }
      if (live.some((l) => l.agent === pin.agent && l.sessionId === pin.sessionId)) {
        deps.log?.info(`resume ${pin.id}: session ${pin.sessionId} already alive, skipped`);
        out.skipped.push({ id: pin.id, reason: 'alive' });
        continue;
      }
      if (deps.held?.(pin.agent, pin.sessionId)) {
        deps.log?.info(`resume ${pin.id}: session ${pin.sessionId} is held by a Mark42 window, skipped`);
        out.skipped.push({ id: pin.id, reason: 'alive', detail: 'held by a Mark42 window' });
        continue;
      }
      go.push(pin);
    }
    resolvePlanned(go.map((p) => p.id));

    const gap = deps.gapMs ?? 1000;
    const sleep = deps.sleep ?? defaultSleep;
    const resultTimeout = deps.resultTimeoutMs ?? 120_000;
    let launchedAny = false;
    for (const pin of go) {
      if (launchedAny && gap > 0) await sleep(gap);
      // 앞 창을 기다리는 사이 다른 경로(hub 클릭)로 열렸을 수 있어요
      if (deps.held?.(pin.agent, pin.sessionId)) {
        out.skipped.push({ id: pin.id, reason: 'alive', detail: 'held by a Mark42 window' });
        continue;
      }
      let r: OpenOutcome;
      try {
        r = await deps.open(
          { folderPath: pin.folderPath, role: AGENT_ROLES[pin.agent], sessionId: pin.sessionId },
          { settings: pin.settings, prompt: pin.resumePrompt, autoSend: pin.autoSend },
        );
      } catch (e) {
        deps.log?.warn(`resume ${pin.id}: open failed: ${errMsg(e)}`);
        out.skipped.push({ id: pin.id, reason: 'launch-failed', detail: errMsg(e) });
        continue;
      }
      launchedAny = true;
      out.started.push(pin.id);
      deps.log?.info(`resume ${pin.id}: ${r.status} slot=${r.slotId ?? '-'}`);
      if (pin.autoSend && r.requestId && deps.waitResult) {
        const rep = await deps.waitResult(r.requestId, resultTimeout);
        if (!rep) deps.log?.warn(`resume ${pin.id}: no result within ${resultTimeout}ms, continuing`);
        else deps.log?.info(`resume ${pin.id}: window reported ok=${rep.ok} ${rep.detail ?? ''}`);
      }
    }
    return out;
  })();
  // 사전 확인 전에 실패해도 planned가 매달리지 않게
  done.then(
    () => undefined,
    () => resolvePlanned([]),
  );
  return { planned, done };
}

export function runResume(deps: ResumeDeps, pinnedIds?: string[]): Promise<ResumeOutcome> {
  return startResume(deps, pinnedIds).done;
}

/** 프로세스 시작 때의 SESSIONNAME(RDP-…). 세션 재연결은 못 봐요 — 대체 판정용이에요. */
export function isRemoteSessionFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^RDP-/i.test(env.SESSIONNAME ?? '');
}

export interface ProbeResult {
  code: number | null;
  stdout: string;
}
export type ProbeRunner = (file: string, args: string[], timeoutMs: number) => Promise<ProbeResult>;

const defaultProbeRunner: ProbeRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/** GetSystemMetrics(SM_REMOTESESSION) — 자식 프로세스는 데몬과 같은 Windows 세션에서 돌아서 «지금» 원격인지 알려 줘요. */
export const REMOTE_SESSION_PROBE_SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms; [Console]::Out.Write([System.Windows.Forms.SystemInformation]::TerminalServerSession)';

/**
 * 실행 중에 바뀌는 원격 세션 여부. 콘솔에서 로그온한 세션에 나중에 RDP·RemoteApp으로 다시 붙으면(같은 세션) true가 돼요.
 * 조회가 실패하면 환경 변수 판정으로 대신해요.
 */
export function createRemoteSessionProbe(
  run: ProbeRunner = defaultProbeRunner,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): () => Promise<boolean> {
  return async () => {
    if (platform !== 'win32') return isRemoteSessionFromEnv(env);
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', REMOTE_SESSION_PROBE_SCRIPT], 20_000);
    const v = r.stdout.trim().toLowerCase();
    if (r.code === 0 && (v === 'true' || v === 'false')) return v === 'true';
    return isRemoteSessionFromEnv(env);
  };
}

export interface BootResumeOptions {
  mode: ResumeMode;
  run: () => Promise<ResumeOutcome>;
  isRemoteSession?: () => boolean | Promise<boolean>;
  /** firstRemoteApp 대기 중 확인 간격. 기본 10초 */
  pollMs?: number;
  log?: Logger;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface BootResumeHandle {
  /** 재개를 실행했으면 그 결과, 취소됐으면 undefined */
  done: Promise<ResumeOutcome | undefined>;
  /** 아직 기다리는 중이면 지금 실행해요(다른 세션의 --boot 인스턴스가 넘겨준 경우). 실행했으면 true */
  trigger(reason: string): boolean;
  readonly waiting: boolean;
  cancel(): void;
}

/**
 * D28 부팅 재개 골격.
 * - console: 바로 재개해요.
 * - firstRemoteApp: 지금 원격 세션이면 바로, 아니면 pollMs마다 다시 확인(실행 중 조회라 콘솔 세션에 RDP로 다시 붙는 것도 잡아요).
 *   다른 Windows 세션의 --boot 인스턴스는 파이프가 이미 있어서 `$/bootResume`으로 trigger를 불러요.
 *   한계: 창은 데몬의 Windows 세션에 떠요. 별도 RDP 세션에 창을 띄우려면 세션별 데몬이 필요해요.
 */
export function runBootResume(opts: BootResumeOptions): BootResumeHandle {
  const isRemote = opts.isRemoteSession ?? (() => isRemoteSessionFromEnv());
  const pollMs = opts.pollMs ?? 10_000;
  const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms).unref());
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let cancelled = false;
  let ran = false;
  let timer: unknown;
  let settle: (v: ResumeOutcome | undefined) => void = () => undefined;
  let fail: (e: unknown) => void = () => undefined;
  const done = new Promise<ResumeOutcome | undefined>((res, rej) => {
    settle = res;
    fail = rej;
  });
  const runOnce = (why: string) => {
    if (ran || cancelled) return false;
    ran = true;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    opts.log?.info(`boot resume: running (mode=${opts.mode}, ${why})`);
    opts.run().then(settle, fail);
    return true;
  };
  if (opts.mode === 'console') {
    runOnce('console');
  } else {
    const check = async () => {
      if (cancelled || ran) return;
      let remote = false;
      try {
        remote = await isRemote();
      } catch (e) {
        opts.log?.warn(`boot resume: remote check failed: ${errMsg(e)}`);
      }
      if (cancelled || ran) return;
      if (remote) runOnce('remote session');
      else timer = setTimer(() => void check(), pollMs);
    };
    opts.log?.info('boot resume: waiting for first RemoteApp session (D28 b)');
    void check();
  }
  return {
    done,
    trigger: (reason) => runOnce(reason),
    get waiting() {
      return !ran && !cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer !== undefined) clearTimer(timer);
      if (!ran) settle(undefined);
    },
  };
}
