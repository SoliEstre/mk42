// OS 부팅 시각 — 재부팅 전에 남은 상태 파일(죽은 프로세스의 흔적)을 가려내는 데 써요.
import { uptime } from 'node:os';

/** uptime 해상도·시계 보정 여유 */
export const BOOT_SLACK_MS = 2 * 60_000;

/** epoch ms */
export function bootTimeMs(now: number = Date.now(), uptimeSec: number = uptime()): number {
  return now - uptimeSec * 1000;
}

/** t(epoch ms)가 이번 부팅보다 확실히 이전이면 true */
export function beforeThisBoot(t: number, boot: number = bootTimeMs()): boolean {
  return Number.isFinite(t) && t > 0 && t < boot - BOOT_SLACK_MS;
}
