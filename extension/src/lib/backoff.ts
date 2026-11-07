// 재연결 간격: 1→2→4→8→16→30초(상한) — 계약 mk42d-ipc §2

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/** attempt는 0부터: 0→1s, 1→2s, 2→4s, … 상한 30s */
export function backoffDelay(attempt: number, baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS): number {
  if (!Number.isFinite(attempt) || attempt < 0) attempt = 0;
  const exp = Math.min(Math.floor(attempt), 30);
  return Math.min(baseMs * 2 ** exp, maxMs);
}

export class Backoff {
  #attempt = 0;
  readonly baseMs: number;
  readonly maxMs: number;
  constructor(baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
  }
  get attempt(): number {
    return this.#attempt;
  }
  /** 다음 대기 시간을 돌려주고 시도 횟수를 올려요. */
  next(): number {
    const d = backoffDelay(this.#attempt, this.baseMs, this.maxMs);
    this.#attempt++;
    return d;
  }
  reset(): void {
    this.#attempt = 0;
  }
}
