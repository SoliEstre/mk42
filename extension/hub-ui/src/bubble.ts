// 누른 자리 옆 말풍선 (2026-11-02 사용자 요청). 창 열기 같은 동작의 결과가 통합 창 위쪽 알림으로만 나오면 스크롤했을 때 안 보이고,
// 누른 곳과 멀어 눌렸는지 알기 어려워요 — 그래서 방금 누른 단추(없으면 누른 점) 옆에 짧게 띄워요. 단추가 스크롤로 움직이면 따라가요.
import { el } from './dom.ts';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BubblePlacement {
  left: number;
  top: number;
  /** 단추 아래(below)·위(above) */
  side: 'below' | 'above';
  /** 말풍선 왼쪽에서 꼬리까지(px) — 꼬리가 단추 가운데를 가리켜요 */
  arrowX: number;
}

/**
 * 단추(anchor) 위에 두되(2026-11-02 사용자 요청) 화면 위가 모자라면 아래로. 가로는 단추 가운데에 맞추고 화면 안으로 밀어 넣어요(가장자리 margin).
 * gap은 꼬리(10px 마름모, 바깥으로 약 8px)가 단추 글자에 닿지 않을 만큼 — 8이면 꼬리 끝이 단추 테두리에 닿아 글자를 가렸어요.
 */
export function placeBubble(anchor: Rect, size: { width: number; height: number }, viewport: { width: number; height: number }, gap = 12, margin = 8): BubblePlacement {
  const centerX = (anchor.left + anchor.right) / 2;
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const side: 'below' | 'above' = above >= margin ? 'above' : 'below';
  const top = side === 'below' ? Math.min(below, Math.max(margin, viewport.height - margin - size.height)) : above;
  const maxLeft = Math.max(margin, viewport.width - margin - size.width);
  const left = Math.min(maxLeft, Math.max(margin, centerX - size.width / 2));
  const arrowX = Math.min(size.width - 12, Math.max(12, centerX - left));
  return { left: Math.round(left), top: Math.round(top), side, arrowX: Math.round(arrowX) };
}

/** 방금 사용자가 누른 곳 — 이 시간 안에 온 메시지만 그 옆에 띄워요 */
export const ANCHOR_TTL_MS = 15_000;

export interface Anchor {
  el?: HTMLElement;
  /** 다시 그려져 단추가 바뀌어도 같은 단추를 다시 찾는 키(data-focus-key) */
  key?: string;
  /** 마지막으로 잰 단추 자리 — 다시 그려져 단추를 못 찾으면 누른 점(글자 한가운데) 대신 이 자리 옆에 띄워요 */
  rect?: Rect;
  x: number;
  y: number;
  at: number;
}

/** 누른 대상에서 말풍선을 붙일 요소 — 단추·링크만(입력칸·빈 곳은 아니에요) */
export function anchorElement(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const hit = target.closest('button, a[href], [role="button"], summary');
  return hit instanceof HTMLElement ? hit : undefined;
}

export class Bubble {
  readonly element: HTMLElement;
  #text: HTMLElement;
  #anchor: Anchor | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #onMove = () => this.#place();

  constructor() {
    this.#text = el('span', { cls: 'bubble-text' });
    this.element = el('div', { cls: 'bubble', attrs: { role: 'status', hidden: true } }, this.#text);
  }

  show(anchor: Anchor, message: string, kind: 'error' | 'info'): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#anchor = anchor;
    this.#text.textContent = message;
    this.element.dataset.kind = kind;
    this.element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    this.element.hidden = false;
    this.#place();
    window.addEventListener('scroll', this.#onMove, true);
    window.addEventListener('resize', this.#onMove);
    this.#timer = setTimeout(() => this.hide(), kind === 'error' ? 8000 : 3500);
  }

  hide(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.element.hidden = true;
    this.#anchor = undefined;
    window.removeEventListener('scroll', this.#onMove, true);
    window.removeEventListener('resize', this.#onMove);
  }

  #place(): void {
    const a = this.#anchor;
    if (!a || this.element.hidden) return;
    if (a.el && !a.el.isConnected && a.key) {
      for (const c of document.querySelectorAll<HTMLElement>('[data-focus-key]')) {
        if (c.dataset.focusKey === a.key) {
          a.el = c;
          break;
        }
      }
    }
    if (a.el?.isConnected) {
      const b = a.el.getBoundingClientRect();
      a.rect = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    }
    const r: Rect = a.rect ?? { left: a.x, right: a.x, top: a.y, bottom: a.y };
    // 지난 자리(오른쪽 끝 등)에서 재면 좁고 길게 재여요 — 왼쪽 위에서 원래 크기로 재요
    this.element.style.left = '0px';
    this.element.style.top = '0px';
    const size = { width: this.element.offsetWidth, height: this.element.offsetHeight };
    const p = placeBubble(r, size, { width: window.innerWidth, height: window.innerHeight });
    this.element.style.left = `${p.left}px`;
    this.element.style.top = `${p.top}px`;
    this.element.dataset.side = p.side;
    this.element.style.setProperty('--arrow-x', `${p.arrowX}px`);
  }
}
