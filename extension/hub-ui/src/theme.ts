// 별도 통합 창(B)이 VS Code 테마를 따라가요: 데몬의 `theme.get`(가장 최근에 포커스된 Mark42 창의 테마 색)을 받아 웹뷰와 같은 이름의
// CSS 변수(--vscode-*)로 넣어요 — hub-ui.css는 그 변수를 먼저 쓰고, 없는 색은 테마 종류(data-m42-kind)의 대체값을 써요.
// 데몬이 `state.changed {topics:['theme']}`를 보내면 다시 받아요. 웹뷰(A)는 VS Code가 변수를 직접 넣으니 쓰지 않아요.
import { HUB_THEME_COLOR_IDS, sanitizeHubTheme, themeCssVar, type HubTheme } from '@mark42/protocol';
import type { HubConnection } from './transport.ts';

/** 테마 종류별 body 클래스(웹뷰에서 VS Code가 붙이는 것과 같은 이름) */
const KIND_CLASS: Record<HubTheme['kind'], string[]> = {
  light: ['vscode-light'],
  dark: ['vscode-dark'],
  highContrast: ['vscode-high-contrast'],
  highContrastLight: ['vscode-high-contrast', 'vscode-high-contrast-light'],
};

interface StyleTarget {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  dataset: Record<string, string | undefined>;
}
interface ClassTarget {
  classList: { add(...t: string[]): void; remove(...t: string[]): void };
}

/** 테마를 적용해요(null이면 OS 밝기를 따르는 기본으로). 받은 값은 다시 검사해요 — CSS에 그대로 들어가니까. */
export function applyHubTheme(root: StyleTarget, body: ClassTarget, raw: unknown): void {
  const theme = raw === null ? undefined : sanitizeHubTheme(raw);
  for (const id of HUB_THEME_COLOR_IDS) {
    const v = theme?.colors[id];
    if (v) root.style.setProperty(themeCssVar(id), v);
    else root.style.removeProperty(themeCssVar(id));
  }
  body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light');
  if (theme) {
    root.dataset.m42Kind = theme.kind;
    body.classList.add(...KIND_CLASS[theme.kind]);
  } else {
    delete root.dataset.m42Kind;
  }
}

/** 붙을 때와 `state.changed`에 theme가 있을 때 테마를 받아 적용해요. 해제 함수를 돌려줘요. */
export function syncHubTheme(conn: HubConnection, apply: (theme: unknown) => void): () => void {
  let gen = 0;
  const load = async () => {
    const my = ++gen;
    try {
      const r = await conn.request('theme.get', {});
      if (my === gen) apply(r.theme ?? null);
    } catch {
      // 옛 데몬(theme.get 없음)·끊김: 지금 모양 그대로
    }
  };
  const offConn = conn.onConnectionChange((connected) => {
    if (connected) void load();
  });
  const offNote = conn.onNotification((method, params) => {
    if (method !== 'state.changed') return;
    const topics = (params as { topics?: unknown }).topics;
    if (Array.isArray(topics) && topics.includes('theme')) void load();
  });
  if (conn.connected) void load();
  return () => {
    offConn();
    offNote();
  };
}
