// 인덱서 변경 감시 공용 도구: 묶어 부르기(coalesce) + 서명 폴링.

export interface Coalescer {
  trigger(): void;
  cancel(): void;
}

/**
 * 첫 trigger 뒤 ms 안에 들어온 trigger를 한 번으로 묶어요.
 * 순수 trailing 디바운스와 달리 계속 쓰이는 세션 파일이 있어도 ms마다 한 번은 불려요.
 */
export function coalesce(fn: () => void, ms: number): Coalescer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        try {
          fn();
        } catch {
          // 호출 측 오류는 감시를 멈추지 않아요.
        }
      }, ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export interface Poller {
  stop(): void;
}

/** intervalMs마다 서명을 계산해서 바뀌면 onChange. 첫 계산은 기준값이에요. */
export function pollSignature(
  compute: () => Promise<string>,
  intervalMs: number,
  onChange: () => void,
  log?: (m: string) => void,
): Poller {
  let last: string | undefined;
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const sig = await compute();
      if (last !== undefined && sig !== last && !stopped) onChange();
      last = sig;
    } catch (e) {
      log?.(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
