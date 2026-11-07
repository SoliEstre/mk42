// C3(2026-11-05) 창 띄우기 준비 진행 — 첫 실행 때 Mark42 확장·한국어 언어 팩 설치, 창 열기, 에이전트 확장 받기를
// `<home>\run\launch-progress.json`에 써요. 준비가 700ms 넘게 걸리면 작은 진행 창(`mk42-hub.exe --progress <파일>`)을 띄워요.
// 한꺼번에 여러 창을 띄우면(재개) 한 파일에 단계를 합쳐요 — 모두 끝나야 done. 실패는 창을 막지 않아요(실패 단계 + 경고 로그).
import { existsSync, promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathKey } from '@mark42/protocol/paths';
import { hubHostExe } from './edge.ts';
import { atomicWriteFile } from './fsutil.ts';
import { defineMessages, osUiLanguage, type UiLanguage } from './i18n.ts';
import { defaultSpawn, sanitizeLaunchEnv } from './launcher.ts';
import { errMsg, type Logger } from './log.ts';

export type LaunchStepId = 'mark42-extension' | 'language-pack' | 'open-window' | 'codex-extension' | 'claude-extension';
export type LaunchStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type LaunchStepEnd = 'done' | 'failed' | 'skipped';

export interface LaunchProgressStep {
  id: LaunchStepId;
  label: string;
  state: LaunchStepState;
  detail?: string;
}

/** C3 파일 형식 */
export interface LaunchProgressDoc {
  schema: 1;
  id: string;
  updatedAt: string;
  lang: UiLanguage;
  title: string;
  steps: LaunchProgressStep[];
  done: boolean;
  error: string | null;
}

const t = defineMessages({
  en: {
    title: 'Preparing Mk42',
    'mark42-extension': 'Installing the Mark42 extension',
    'language-pack': 'Installing the Korean language pack',
    'open-window': 'Opening the window',
    'codex-extension': 'Downloading the Codex extension',
    'claude-extension': 'Installing the Claude Code extension',
    error: 'Something went wrong while preparing — log: {0}',
  },
  ko: {
    title: 'Mk42 준비 중',
    'mark42-extension': 'Mark42 확장 설치',
    'language-pack': '한국어 언어 팩 설치',
    'open-window': '창 여는 중',
    'codex-extension': 'Codex 확장 받는 중',
    'claude-extension': 'Claude Code 확장 설치',
    error: '준비하다 문제가 생겼어요 — 로그: {0}',
  },
});

/** 단계 순서(파일에 이 순서로 써요) */
const STEP_ORDER: readonly LaunchStepId[] = ['mark42-extension', 'language-pack', 'open-window', 'codex-extension', 'claude-extension'];

export function launchProgressPath(home: string): string {
  return join(home, 'run', 'launch-progress.json');
}

/** 받은 바이트 → `120 / 600 MB`(전체를 모르면 `120 MB`) */
export function formatBytesDetail(received: number, total?: number): string {
  const mb = (b: number) => String(Math.round(b / (1024 * 1024)));
  return total && total > 0 ? `${mb(received)} / ${mb(total)} MB` : `${mb(received)} MB`;
}

/** 에이전트 확장 업데이트 결과(agentUpdates.ts status) → 단계 끝 — pending(사용자 확인 대기)은 건너뜀 */
export function stepEndOfUpdate(status: string | undefined): LaunchStepEnd {
  if (status === 'updated' || status === 'current') return 'done';
  if (status === 'pending') return 'skipped';
  return 'failed';
}

/** 창 띄우기 하나(AppLauncher.launch)의 진행 보고 */
export interface LaunchTicket {
  /** 그 단계 시작(running) */
  start(id: LaunchStepId, detail?: string): void;
  /** 진행 중인 단계의 덧붙임(예: 받은 MB) */
  detail(id: LaunchStepId, detail: string): void;
  /** 받은 바이트 → detail `120 / 600 MB` */
  bytes(id: LaunchStepId, received: number, total?: number): void;
  finish(id: LaunchStepId, end: LaunchStepEnd): void;
  /** 띄운 창의 Mark42 확장이 hello할 때까지 open-window — 이번 준비에 다른 단계가 있을 때만(평소 창 띄우기에는 진행 창이 안 떠요) */
  waitForWindow(workspaceFile: string): void;
  /** 이 띄우기가 더 붙일 단계가 없어요(시작한 단계는 끝날 때까지 남아요) */
  seal(): void;
}

export interface LaunchProgressLike {
  begin(): LaunchTicket;
}

export interface LaunchProgressOptions {
  home: string;
  /** 문구 언어(기본 {@link osUiLanguage}) */
  language?: () => Promise<UiLanguage>;
  /** 진행 창 띄우기(기본: `mk42-hub.exe --progress <파일>`, exe가 없으면 안 띄워요) — 시험에서 바꿔요 */
  spawnWindow?: (file: string) => Promise<{ pid?: number } | undefined>;
  /** 기본 진행 창 exe(settings.hubHostPath ?? `<home>\hub\mk42-hub.exe`) */
  hubExe?: () => string;
  isAlive?: (pid: number) => boolean;
  /** 준비가 이만큼 넘게 걸릴 때만 진행 창(기본 700ms) */
  showDelayMs?: number;
  /** open-window 최대 대기(기본 90초) */
  windowTimeoutMs?: number;
  /** 파일 쓰기 몰아 쓰기 간격(기본 150ms) */
  writeDelayMs?: number;
  /** 오류 줄에 보여 줄 로그 파일(기본 `<home>\logs\mk42d.log`) */
  logFile?: string;
  now?: () => number;
  log?: Logger;
}

interface StepHolder {
  state: LaunchStepState;
  detail?: string;
  at: number;
}

interface Run {
  id: string;
  startedAt: number;
  steps: Map<LaunchStepId, Map<number, StepHolder>>;
  /** 아직 seal하지 않은 띄우기 */
  open: Set<number>;
  shown: boolean;
  written: boolean;
  finished: boolean;
  showTimer?: ReturnType<typeof setTimeout>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const TERMINAL: ReadonlySet<LaunchStepState> = new Set(['done', 'failed', 'skipped']);

/**
 * 한 번 실패·건너뜀으로 끝난 뒤에는 이 데몬 실행 동안 다시 보이지 않는 단계(검토 2026-11-05) — 검증에 막힌 Claude Code·프록시 뒤 Codex 받기·
 * 언어 팩처럼 계속 실패하는 상태면 창을 띄울 때마다 진행·오류 창이 뜨지 않게. 설치 시도는 그대로 해요(로그에 남아요). 성공하면 다시 보여요.
 */
const QUIET_AFTER_FAILURE: ReadonlySet<LaunchStepId> = new Set(['language-pack', 'codex-extension', 'claude-extension']);
/** 오류 줄은 사용자가 기다리는 단계가 실패했을 때만 — 뒤에서 하는 에이전트 확장 설치 실패는 단계 표시(✕)와 로그로만 */
const ERROR_LINE_STEPS: ReadonlySet<LaunchStepId> = new Set(['mark42-extension', 'language-pack']);

export class LaunchProgress implements LaunchProgressLike {
  readonly file: string;
  #opts: LaunchProgressOptions;
  #run: Run | undefined;
  #seq = 0;
  #windowPid: number | undefined;
  #lang: Promise<UiLanguage> | undefined;
  /** pathKey(워크스페이스 파일) → hello를 기다리는 끝내기 함수들 */
  #waits = new Map<string, Set<() => void>>();
  #writeTimer: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<void> = Promise.resolve();
  #writeWarned = false;
  /** {@link QUIET_AFTER_FAILURE} 중 이번 데몬 실행에서 실패·건너뜀으로 끝난 단계 */
  #quiet = new Set<LaunchStepId>();

  constructor(opts: LaunchProgressOptions) {
    this.#opts = opts;
    this.file = launchProgressPath(opts.home);
  }

  /** 지난 실행(데몬이 죽었을 때 등)이 남긴 파일을 지워요 — 남은 진행 창은 파일이 없어지면 닫혀요 */
  async clearStale(): Promise<void> {
    if (this.#run) return;
    await fsp.rm(this.file, { force: true }).catch(() => undefined);
  }

  begin(): LaunchTicket {
    const run = this.#currentRun();
    const no = ++this.#seq;
    run.open.add(no);
    const detail = (id: LaunchStepId, text: string) => {
      const h = run.steps.get(id)?.get(no);
      if (h && !TERMINAL.has(h.state)) this.#set(run, no, id, h.state, text);
    };
    const ticket: LaunchTicket = {
      start: (id, text) => {
        if (this.#quiet.has(id) && !run.steps.get(id)?.has(no)) return;
        this.#set(run, no, id, 'running', text);
      },
      detail,
      bytes: (id, received, total) => detail(id, formatBytesDetail(received, total)),
      finish: (id, end) => {
        if (QUIET_AFTER_FAILURE.has(id)) {
          if (end === 'done') this.#quiet.delete(id);
          else this.#quiet.add(id);
        }
        if (run.steps.get(id)?.has(no)) this.#set(run, no, id, end);
      },
      waitForWindow: (workspaceFile) => this.#waitForWindow(run, no, workspaceFile),
      seal: () => {
        if (!run.open.delete(no)) return;
        this.#changed(run);
      },
    };
    return ticket;
  }

  /** 창의 Mark42 확장이 데몬에 hello했어요(server.ts) — 그 워크스페이스의 open-window를 끝내요 */
  windowHello(workspaceFile: string | undefined): void {
    if (!workspaceFile) return;
    const key = pathKey(workspaceFile);
    const set = this.#waits.get(key);
    if (!set) return;
    this.#waits.delete(key);
    for (const done of set) done();
  }

  /** 지금 상태(시험·진단용) */
  snapshot(lang: UiLanguage = 'en'): LaunchProgressDoc | undefined {
    return this.#run ? this.#doc(this.#run, lang) : undefined;
  }

  #currentRun(): Run {
    if (this.#run && !this.#run.finished) return this.#run;
    const run: Run = {
      id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      startedAt: this.#now(),
      steps: new Map(),
      open: new Set(),
      shown: false,
      written: false,
      finished: false,
    };
    this.#run = run;
    const delay = this.#opts.showDelayMs ?? 700;
    run.showTimer = setTimeout(() => void this.#maybeShow(run), delay);
    run.showTimer.unref?.();
    return run;
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  #language(): Promise<UiLanguage> {
    this.#lang ??= (this.#opts.language ?? osUiLanguage)().catch(() => 'en' as const);
    return this.#lang;
  }

  /** open-window를 뺀 단계가 있나 — 이게 «준비»예요 */
  #hasWork(run: Run): boolean {
    return [...run.steps.keys()].some((id) => id !== 'open-window');
  }

  #set(run: Run, no: number, id: LaunchStepId, state: LaunchStepState, detail?: string): void {
    if (run.finished) return;
    let holders = run.steps.get(id);
    if (!holders) {
      holders = new Map();
      run.steps.set(id, holders);
    }
    const prev = holders.get(no);
    holders.set(no, { state, detail: detail ?? (state === 'running' ? prev?.detail : undefined), at: this.#now() });
    if (state === 'running' && id !== 'open-window' && this.#now() - run.startedAt >= (this.#opts.showDelayMs ?? 700)) void this.#maybeShow(run);
    this.#changed(run, TERMINAL.has(state));
  }

  #waitForWindow(run: Run, no: number, workspaceFile: string): void {
    if (run.finished || !this.#hasWork(run)) return;
    const key = pathKey(workspaceFile);
    let finished = false;
    const end = (state: LaunchStepEnd) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.#waits.get(key)?.delete(onHello);
      if (this.#waits.get(key)?.size === 0) this.#waits.delete(key);
      this.#set(run, no, 'open-window', state);
    };
    const onHello = () => end('done');
    const timer = setTimeout(() => {
      this.#opts.log?.warn(`no hello from the window of ${workspaceFile} within ${Math.round((this.#opts.windowTimeoutMs ?? 90_000) / 1000)} s`);
      end('skipped');
    }, this.#opts.windowTimeoutMs ?? 90_000);
    timer.unref?.();
    let set = this.#waits.get(key);
    if (!set) {
      set = new Set();
      this.#waits.set(key, set);
    }
    set.add(onHello);
    this.#set(run, no, 'open-window', 'running');
  }

  /** 단계 하나의 모아 본 상태: 하나라도 진행 중이면 running, 아니면 실패가 있으면 failed, 다 건너뛰었으면 skipped, 나머지 done */
  #aggregate(holders: Map<number, StepHolder>): { state: LaunchStepState; detail?: string } {
    const all = [...holders.values()];
    const live = all.filter((h) => !TERMINAL.has(h.state));
    if (live.length > 0) {
      const state = live.some((h) => h.state === 'running') ? 'running' : 'pending';
      const detail = live.filter((h) => h.detail).sort((a, b) => b.at - a.at)[0]?.detail;
      return detail ? { state, detail } : { state };
    }
    if (all.some((h) => h.state === 'failed')) return { state: 'failed' };
    if (all.every((h) => h.state === 'skipped')) return { state: 'skipped' };
    return { state: 'done' };
  }

  #isDone(run: Run): boolean {
    if (run.open.size > 0) return false;
    for (const holders of run.steps.values()) if (!TERMINAL.has(this.#aggregate(holders).state)) return false;
    return true;
  }

  #doc(run: Run, lang: UiLanguage): LaunchProgressDoc {
    const steps: LaunchProgressStep[] = [];
    for (const id of STEP_ORDER) {
      const holders = run.steps.get(id);
      if (!holders || holders.size === 0) continue;
      const a = this.#aggregate(holders);
      steps.push({ id, label: t(lang, id), state: a.state, ...(a.detail ? { detail: a.detail } : {}) });
    }
    const done = this.#isDone(run);
    const failed = steps.some((s) => s.state === 'failed' && ERROR_LINE_STEPS.has(s.id));
    return {
      schema: 1,
      id: run.id,
      updatedAt: new Date(this.#now()).toISOString(),
      lang,
      title: t(lang, 'title'),
      steps,
      done,
      error: done && failed ? t(lang, 'error', this.#opts.logFile ?? join(this.#opts.home, 'logs', 'mk42d.log')) : null,
    };
  }

  #changed(run: Run, urgent = false): void {
    if (this.#isDone(run)) {
      run.finished = true;
      if (run.showTimer) clearTimeout(run.showTimer);
      if (this.#run === run) this.#run = undefined;
      // 아무 준비도 없던(또는 한 번도 쓰기 전에 끝난) 띄우기는 파일을 쓰지 않아요
      if (run.written) void this.#flush(run);
      else if (this.#writeTimer) {
        clearTimeout(this.#writeTimer);
        this.#writeTimer = undefined;
      }
      return;
    }
    if (!run.written && !this.#hasWork(run)) return;
    if (urgent) {
      void this.#flush(run);
      return;
    }
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = undefined;
      void this.#flush(run);
    }, this.#opts.writeDelayMs ?? 150);
    this.#writeTimer.unref?.();
  }

  /** 지금 상태를 써요(쓰기는 하나씩 차례로) */
  #flush(run: Run): Promise<void> {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = undefined;
    }
    run.written = true;
    // 차례로 쓰니까 끝난 준비의 마지막 쓰기(done)는 다음 준비의 쓰기보다 늘 먼저예요
    this.#writing = this.#writing.then(async () => {
      try {
        const lang = await this.#language();
        await atomicWriteFile(this.file, `${JSON.stringify(this.#doc(run, lang), null, 1)}\n`);
      } catch (e) {
        if (!this.#writeWarned) this.#opts.log?.warn(`launch progress not written (${errMsg(e)}): ${this.file}`);
        this.#writeWarned = true;
      }
    });
    return this.#writing;
  }

  async #maybeShow(run: Run): Promise<void> {
    if (run.finished || run.shown || !this.#hasWork(run) || this.#run !== run) return;
    run.shown = true; // 사용자가 «숨기기»로 닫은 창을 같은 준비에서 다시 띄우지 않아요
    const alive = this.#opts.isAlive ?? pidAlive;
    if (this.#windowPid !== undefined && alive(this.#windowPid)) return; // 떠 있는 진행 창이 파일을 계속 읽어요
    await this.#flush(run);
    if (run.finished) return;
    try {
      const r = await (this.#opts.spawnWindow ?? ((file) => this.#defaultSpawnWindow(file)))(this.file);
      this.#windowPid = r?.pid;
      if (r) this.#opts.log?.info(`launch progress window pid=${r.pid ?? '?'}`);
    } catch (e) {
      this.#opts.log?.warn(`launch progress window not opened: ${errMsg(e)}`);
    }
  }

  async #defaultSpawnWindow(file: string): Promise<{ pid?: number } | undefined> {
    const exe = this.#opts.hubExe?.() ?? hubHostExe(this.#opts.home);
    if (!existsSync(exe)) return undefined;
    return defaultSpawn(exe, ['--progress', file], sanitizeLaunchEnv(process.env));
  }
}
