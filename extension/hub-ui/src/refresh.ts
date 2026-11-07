// state.changed 알림을 모아 150ms 뒤 한 번에 다시 조회해요.
import type { StateTopic } from '@mark42/protocol';

export const ALL_TOPICS: readonly StateTopic[] = ['folders', 'sessions', 'windows', 'pinned', 'tasks'];

export interface TimerApi {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultTimers: TimerApi = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** 폴더 목록이 바뀌면 폴더별 세션도 다시 읽어야 해서 sessions를 덧붙여요. */
export function expandTopics(topics: Iterable<StateTopic>): Set<StateTopic> {
  const out = new Set<StateTopic>();
  for (const t of topics) if ((ALL_TOPICS as readonly string[]).includes(t)) out.add(t);
  if (out.has('folders')) {
    out.add('sessions');
    out.add('windows');
  }
  return out;
}

export class TopicDebouncer {
  #pending = new Set<StateTopic>();
  #handle: unknown = undefined;
  #delay: number;
  #timers: TimerApi;
  #flush: (topics: Set<StateTopic>) => void;

  constructor(flush: (topics: Set<StateTopic>) => void, delayMs = 150, timers: TimerApi = defaultTimers) {
    this.#flush = flush;
    this.#delay = delayMs;
    this.#timers = timers;
  }

  push(topics: Iterable<StateTopic>): void {
    for (const t of expandTopics(topics)) this.#pending.add(t);
    if (this.#pending.size === 0) return;
    if (this.#handle !== undefined) this.#timers.clearTimeout(this.#handle);
    this.#handle = this.#timers.setTimeout(() => this.flushNow(), this.#delay);
  }

  flushNow(): void {
    if (this.#handle !== undefined) this.#timers.clearTimeout(this.#handle);
    this.#handle = undefined;
    if (this.#pending.size === 0) return;
    const topics = this.#pending;
    this.#pending = new Set();
    this.#flush(topics);
  }

  dispose(): void {
    if (this.#handle !== undefined) this.#timers.clearTimeout(this.#handle);
    this.#handle = undefined;
    this.#pending.clear();
  }
}
