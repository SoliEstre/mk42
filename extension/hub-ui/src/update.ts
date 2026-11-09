// 통합 창 오른쪽 위 «Mk42 업데이트» — 순수 로직(DOM 없음). 상태는 데몬 updater.ts(계약 C4)의 update.status·update.changed.
// 판(state)마다: 무엇을 보여 주고(글·색·진행), 어떤 단추를 켤지(확인·받기·설치), 설정 메뉴(자동 받기·자동 설치)를 보일지.
import type { Mk42UpdateAuto, Mk42UpdateState, Mk42UpdateStatus } from '@mark42/protocol';
import { t } from './i18n.ts';
import { formatRelativeTime } from './model.ts';

/** 통합 창이 지금 보내 놓고 기다리는 요청 — 그 동안 단추를 꺼요(두 번 누르기 막기) */
export type UpdateBusy = 'check' | 'download' | 'install' | 'auto';

/** ok = 최신·채널 있음, new = 새 판(받기·설치할 것), busy = 확인·받기·설치 중, error, off = 채널 없음 */
export type UpdateTone = 'ok' | 'new' | 'busy' | 'error' | 'off';

export interface UpdateView {
  tone: UpdateTone;
  /** 머리 줄에 보이는 짧은 글 */
  label: string;
  /** 마우스를 올리면 보이는 자세한 글(줄바꿈) */
  title: string;
  /** 받는 중 0\~1 — 없으면 진행 막대를 숨겨요 */
  progress?: number;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
  /** 설정 메뉴(자동 받기·자동 설치). 옛 데몬·채널 없는 설치본이면 undefined(메뉴를 숨겨요) */
  auto?: Mk42UpdateAuto;
}

const STATES: ReadonlySet<Mk42UpdateState> = new Set<Mk42UpdateState>([
  'disabled',
  'idle',
  'checking',
  'available',
  'downloading',
  'ready',
  'installing',
  'error',
]);

/** 데몬이 보낸 값이 상태 모양인지(옛 데몬·이상한 값은 버려요) */
export function isMk42UpdateStatus(v: unknown): v is Mk42UpdateStatus {
  const s = v as Partial<Mk42UpdateStatus> | null | undefined;
  return typeof s === 'object' && s !== null && typeof s.state === 'string' && STATES.has(s.state) && typeof s.current === 'string';
}

/** 바이트 → «265.6 MB»(1MB 미만은 KB) */
export function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 판 비교(`YYYY.MMDD.HHmmss` — 마디마다 숫자). a가 높으면 양수. 숫자가 아닌 마디는 0으로 봐요 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  const pb = b.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 서버가 알린 판이 설치된 판보다 높은지(설치된 판을 모르면 알린 판이 있으면 높다고 봐요) */
function isNewer(s: Mk42UpdateStatus): boolean {
  if (s.latest === undefined) return false;
  if (s.current === 'unknown') return true;
  return compareVersions(s.latest, s.current) > 0;
}

function progressOf(s: Mk42UpdateStatus): number | undefined {
  const p = s.progress;
  if (!p || !(p.total > 0)) return s.state === 'downloading' ? 0 : undefined;
  return Math.min(1, Math.max(0, p.received / p.total));
}

/** 상태 → 화면. busy면 단추를 다 꺼요(결과·알림이 오면 다시 켜져요) */
export function updateView(s: Mk42UpdateStatus, busy?: UpdateBusy, now: number = Date.now()): UpdateView {
  const latest = s.latest;
  const newer = isNewer(s);
  const lines: string[] = [];
  if (s.state === 'disabled') lines.push(t('update.title.noChannel'));
  lines.push(t('update.title.current', s.current));
  if (s.channel) lines.push(t('update.title.channel', s.channel));
  if (newer && latest !== undefined) lines.push(t('update.title.latest', latest));
  if (newer && s.size !== undefined) lines.push(t('update.title.size', formatBytes(s.size)));
  if (s.state === 'downloading' && s.progress) lines.push(t('update.title.progress', formatBytes(s.progress.received), formatBytes(s.progress.total)));
  if (s.checkedAt) {
    const rel = formatRelativeTime(s.checkedAt, now);
    if (rel) lines.push(t('update.title.checkedAt', rel));
  }
  if (s.auto && s.auto.download === false && s.state !== 'disabled') lines.push(t('update.title.autoDownloadOff'));
  if (s.error) lines.push(t('update.title.error', s.error));
  if (newer && s.notes) lines.push('', s.notes);

  let tone: UpdateTone;
  let label: string;
  let progress: number | undefined;
  switch (s.state) {
    case 'disabled':
      tone = 'off';
      label = t('update.label.current', s.current);
      break;
    case 'checking':
      tone = 'busy';
      label = t('update.label.checking');
      break;
    case 'available':
      tone = 'new';
      label = t('update.label.available', latest ?? '?');
      break;
    case 'downloading':
      tone = 'busy';
      progress = progressOf(s);
      label = t('update.label.downloading', Math.floor((progress ?? 0) * 100));
      break;
    case 'ready':
      tone = 'new';
      label = t('update.label.ready', latest ?? '?');
      break;
    case 'installing':
      tone = 'busy';
      label = t('update.label.installing');
      break;
    case 'error':
      tone = 'error';
      label = t('update.label.error');
      break;
    default:
      tone = 'ok';
      // 한 번이라도 확인했으면 «최신», 아니면 설치된 판만
      label = s.checkedAt ? t('update.label.upToDate', s.current) : t('update.label.current', s.current);
  }

  const idle = busy === undefined;
  return {
    tone,
    label,
    title: lines.join('\n'),
    ...(progress !== undefined ? { progress } : {}),
    canCheck: idle && (s.state === 'idle' || s.state === 'available' || s.state === 'ready' || s.state === 'error'),
    // 받기에 실패한(error) 새 판도 다시 받을 수 있어요(update.download는 서명부터 다시 확인해요). auto가 없는 옛 데몬은 update.download를 몰라요
    canDownload: idle && (s.state === 'available' || (s.state === 'error' && newer && s.auto !== undefined)),
    canInstall: idle && s.state === 'ready',
    ...(s.auto && s.state !== 'disabled' ? { auto: { ...s.auto } } : {}),
  };
}
