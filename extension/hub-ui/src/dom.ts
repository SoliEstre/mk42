// 작은 DOM 빌더. innerHTML·인라인 style을 쓰지 않아서 엄격한 CSP에서도 돌아요.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;
type Handlers = { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };

export interface ElOptions {
  cls?: string | (string | false | null | undefined)[];
  attrs?: Attrs;
  on?: Handlers;
  text?: string;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts.cls) {
    const list = Array.isArray(opts.cls) ? opts.cls : [opts.cls];
    for (const c of list) if (c) e.classList.add(...c.split(/\s+/).filter(Boolean));
  }
  if (opts.text !== undefined) e.textContent = opts.text;
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c);
  }
  // select.value는 option이 붙은 뒤에 넣어야 해서 자식 다음에 속성을 넣어요.
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k in e && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected')) {
        (e as unknown as Record<string, unknown>)[k] = v;
      } else {
        e.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  if (opts.on) {
    for (const [k, h] of Object.entries(opts.on)) if (h) e.addEventListener(k, h as EventListener);
  }
  return e;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 버튼 두 번 누르기 확인 — 웹뷰에서는 window.confirm이 막혀 있어서 써요. */
export function confirmButton(label: string, confirmLabel: string, onConfirm: () => void, cls = ''): HTMLButtonElement {
  let armed: ReturnType<typeof setTimeout> | undefined;
  const b = el('button', {
    cls: ['btn', cls],
    attrs: { type: 'button' },
    text: label,
    on: {
      click: (ev) => {
        ev.stopPropagation();
        if (armed !== undefined) {
          clearTimeout(armed);
          armed = undefined;
          b.textContent = label;
          b.classList.remove('armed');
          onConfirm();
          return;
        }
        b.textContent = confirmLabel;
        b.classList.add('armed');
        armed = setTimeout(() => {
          armed = undefined;
          b.textContent = label;
          b.classList.remove('armed');
        }, 3000);
      },
    },
  });
  return b;
}
