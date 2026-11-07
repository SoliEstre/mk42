// hub UI 진입점 — body[data-transport]로 전송을 골라요: 'webview'(VS Code 웹뷰) / 'ws'(데몬이 띄우는 별도 창).
import { HubApp, type PrefsStore, type UiPrefs } from './app.ts';
import { isHubHostExe } from './host-bridge.ts';
import { parseTokenFromHash, parseWindowNumberFromHash, rpcUrlFor } from './model.ts';
import { applyHubTheme, syncHubTheme } from './theme.ts';
import { language, t } from './i18n.ts';
import { HubStore } from './store.ts';
import type { HubConnection } from './transport.ts';
import { WebviewTransport, type VsCodeApiLike } from './transport-webview.ts';
import { WsTransport } from './transport-ws.ts';

const PREFS_KEY = 'mark42.hub.ui';

/** 토큰이 지난 뒤 데몬이 새 주소를 넘겨주길 기다리는 시간(Mk42 통합 창 exe 안) */
const HANDOFF_WAIT_MS = 30_000;

function webviewPrefs(api: VsCodeApiLike): PrefsStore {
  return {
    load: () => {
      const s = api.getState() as { prefs?: Partial<UiPrefs> } | undefined;
      return s?.prefs;
    },
    save: (prefs) => api.setState({ prefs }),
  };
}

function localPrefs(): PrefsStore {
  return {
    load: () => {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        return raw ? (JSON.parse(raw) as Partial<UiPrefs>) : undefined;
      } catch {
        return undefined;
      }
    },
    save: (prefs) => {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // 저장소가 막혀 있어도 계속
      }
    },
  };
}

function boot(): void {
  const body = document.body;
  const mode = body.dataset.transport === 'webview' ? 'webview' : 'ws';
  const root = document.getElementById('app') ?? body.appendChild(document.createElement('div'));
  root.id = 'app';
  body.classList.add(`m42-${mode}`);
  document.documentElement.lang = language();

  let conn: HubConnection & { start(): void };
  let prefs: PrefsStore;
  if (mode === 'webview') {
    const acquire = (globalThis as { acquireVsCodeApi?: () => VsCodeApiLike }).acquireVsCodeApi;
    if (!acquire) {
      root.textContent = t('boot.noWebviewApi');
      return;
    }
    const api = acquire();
    conn = new WebviewTransport(api, (cb) => {
      const h = (ev: MessageEvent) => cb(ev.data);
      window.addEventListener('message', h);
      return () => window.removeEventListener('message', h);
    });
    prefs = webviewPrefs(api);
  } else {
    conn = new WsTransport({
      url: rpcUrlFor(location),
      token: parseTokenFromHash(location.hash),
      windowNumber: parseWindowNumberFromHash(location.hash),
    });
    prefs = localPrefs();
    document.title = t('app.title');
  }

  let app: HubApp | undefined;
  const store = new HubStore(conn, {
    onError: (m) => app?.toast(m, 'error'),
    onInfo: (m) => app?.toast(m, 'info'),
  });
  app = new HubApp(root, store, prefs);
  app.mount();
  store.start();
  // 별도 창: VS Code(가장 최근에 포커스된 Mark42 창) 테마 색을 따라가요. 웹뷰는 VS Code가 직접 넣어 줘요.
  if (conn.kind === 'ws') syncHubTheme(conn, (t) => applyHubTheme(document.documentElement, document.body, t));
  conn.start();
  // 별도 창: 네트워크가 돌아오거나 창이 다시 보이면 백오프를 기다리지 않고 붙어요.
  // 통합 창은 하나만: 더 새로 연 통합 창이 붙었거나(superseded), 데몬이 다시 떠서 이 창의 토큰이 지난 것이면(authFailed) 이 창은
  // 닫혀요(Mk42 통합 창 exe는 WindowCloseRequested로, Edge --app 창은 기록이 한 칸이라 스크립트로 닫혀요). 못 닫으면 안내가 남아요.
  // Mk42 통합 창 exe 안에서는 토큰이 지나도 바로 닫지 않아요: 데몬이 다시 뜨면 곧 새 주소를 넘겨 이 창을 이어요(hub-host.json).
  // 옛 토큰으로 다시 붙는 쪽이 넘겨받기보다 먼저 거절되면 창이 닫혀 버렸어요(2026-10-27 실사용 중). 한참 넘겨받지 못하면 그때 닫아요.
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  conn.onStatusChange((s) => {
    if (conn.kind !== 'ws') return;
    if (s === 'superseded') window.close();
    else if (s === 'authFailed') {
      if (!isHubHostExe()) window.close();
      else closeTimer ??= setTimeout(() => window.close(), HANDOFF_WAIT_MS);
    } else if (s === 'connected' && closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  });
  const kick = () => conn.reconnectNow?.();
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  window.addEventListener('beforeunload', () => {
    app?.dispose();
    store.dispose();
    conn.dispose();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
