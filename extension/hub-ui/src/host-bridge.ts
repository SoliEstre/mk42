// Mk42 통합 창 exe(mark42/hub-host, WebView2)와 주고받는 것 — 폴더 선택 대화상자. 별도 창 모드에서만 있어요.
// exe가 문서마다 `window.mk42HubHost = { pickFolder: 1 }`을 넣어 두고, chrome.webview 메시지로 대화상자를 띄워 답해요.
// 그 표시가 없으면(Edge로 띄운 통합 창, 옛 exe) 폴더 선택 단추를 감춰요.

export interface WebViewLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
}

export interface HostBridgeGlobal {
  mk42HubHost?: { pickFolder?: number };
  chrome?: { webview?: WebViewLike };
}

export interface PickFolderOptions {
  /** 대화상자 제목 */
  title: string;
  /** 처음 열어 둘 폴더(있으면) */
  initial?: string;
}

/** Mk42 통합 창 exe 안인지(Edge --app 창이 아니라) — 데몬이 다시 뜨면 exe가 새 주소를 넘겨받아 이 화면을 다시 불러요 */
export function isHubHostExe(g: HostBridgeGlobal = globalThis as HostBridgeGlobal): boolean {
  return !!g.mk42HubHost;
}

/** 폴더 선택을 띄울 수 있는 exe 안인지 */
export function canPickFolder(g: HostBridgeGlobal = globalThis as HostBridgeGlobal): boolean {
  return !!g.mk42HubHost?.pickFolder && typeof g.chrome?.webview?.postMessage === 'function';
}

let nextId = 1;

/** 폴더 선택 대화상자 → 고른 절대 경로, 취소하면 null. exe 밖이면 null */
export function pickFolder(opts: PickFolderOptions, g: HostBridgeGlobal = globalThis as HostBridgeGlobal): Promise<string | null> {
  const wv = g.chrome?.webview;
  if (!canPickFolder(g) || !wv) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    const onMessage = (ev: { data: unknown }) => {
      const d = ev.data as { type?: unknown; id?: unknown; path?: unknown } | null;
      if (!d || d.type !== 'pickFolderResult' || d.id !== id) return;
      wv.removeEventListener('message', onMessage);
      resolve(typeof d.path === 'string' && d.path ? d.path : null);
    };
    wv.addEventListener('message', onMessage);
    wv.postMessage({ type: 'pickFolder', id, title: opts.title, ...(opts.initial ? { initial: opts.initial } : {}) });
  });
}

/** 주소처럼 생긴 글(스킴:// 또는 user@host:) — 저장소 주소로 못 쓰면 경로로 등록하지 않고 알려요 */
export function looksLikeRepoAddress(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/|^[^\s@\\/]+@[^\s:]{2,}:/i.test(text.trim());
}

/** C:\… · C:/… · \\server\… */
export function isAbsoluteWinPath(text: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\)/.test(text);
}

/** 최근 쓴 폴더(등록한 폴더·클론 위치) 목록: 맨 앞에 넣고 같은 경로(대소문자·끝 구분자 무시)는 하나로, 최대 max개 */
export function pushRecentFolder(list: readonly string[], path: string, max = 10): string[] {
  const p = path.trim();
  if (!p) return [...list];
  const key = (s: string) => s.replace(/[\\/]+$/, '').toLowerCase();
  return [p, ...list.filter((x) => key(x) !== key(p))].slice(0, max);
}
