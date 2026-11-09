import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, RpcError, type DaemonApi, type HostToWebview } from '@mark42/protocol';
import { HubRelay, hubHtml, RELAY_MAX_TIMEOUT_MS } from '../src/lib/hubRelay.ts';
import { koT } from './helpers/l10n.ts';

function fakeApi(impl: (method: string, params: unknown) => Promise<unknown>, notes: unknown[] = []): DaemonApi {
  return {
    request: ((m: string, p: unknown) => impl(m, p)) as DaemonApi['request'],
    notify: ((m: string, p: unknown) => {
      notes.push([m, p]);
    }) as DaemonApi['notify'],
    onNotification: () => () => {},
  };
}

test('rpc relayed to daemon and result posted back', async () => {
  const posted: HostToWebview[] = [];
  const relay = new HubRelay({
    post: (m) => posted.push(m),
    api: () => fakeApi(async (m) => (m === 'folders.list' ? [{ id: 'f' }] : {})),
    onHostMessage: () => {},
  });
  await relay.handle({ type: 'rpc', id: 7, method: 'folders.list', params: {} });
  assert.deepEqual(posted, [{ type: 'rpcResult', id: 7, result: [{ id: 'f' }] }]);
});

test('rpc: the webview timeout is used for the daemon request (capped at 15 min); none → default', async () => {
  const seen: (number | undefined)[] = [];
  const api: DaemonApi = {
    request: ((_m: string, _p: unknown, timeoutMs?: number) => {
      seen.push(timeoutMs);
      return Promise.resolve({});
    }) as DaemonApi['request'],
    notify: (() => {}) as DaemonApi['notify'],
    onNotification: () => () => {},
  };
  const relay = new HubRelay({ post: () => {}, api: () => api, onHostMessage: () => {} });
  await relay.handle({ type: 'rpc', id: 1, method: 'update.check', params: {}, timeoutMs: 90_000 });
  await relay.handle({ type: 'rpc', id: 2, method: 'folders.clone', params: {}, timeoutMs: 24 * 60 * 60_000 });
  await relay.handle({ type: 'rpc', id: 3, method: 'folders.list', params: {} });
  await relay.handle({ type: 'rpc', id: 4, method: 'folders.list', params: {}, timeoutMs: -5 });
  assert.deepEqual(seen, [90_000, RELAY_MAX_TIMEOUT_MS, undefined, undefined]);
});

test('rpc errors carry code; disconnected answers immediately', async () => {
  const posted: HostToWebview[] = [];
  let connected = true;
  const relay = new HubRelay({
    post: (m) => posted.push(m),
    api: () => (connected ? fakeApi(async () => Promise.reject(new RpcError(ErrorCode.NotFound, 'nope'))) : undefined),
    onHostMessage: () => {},
  });
  await relay.handle({ type: 'rpc', id: 1, method: 'folders.remove', params: { folderId: 'x' } });
  connected = false;
  await relay.handle({ type: 'rpc', id: 2, method: 'folders.list', params: {} });
  await relay.handle({ type: 'ready' });
  assert.deepEqual(posted, [
    { type: 'rpcResult', id: 1, error: { code: ErrorCode.NotFound, message: 'nope' } },
    { type: 'rpcResult', id: 2, error: { code: ErrorCode.InternalError, message: 'daemon disconnected' } },
    { type: 'connection', connected: false },
  ]);
});

test('ui.* notifications stay in host; only allowed notifications reach daemon', async () => {
  const host: unknown[] = [];
  const notes: unknown[] = [];
  const relay = new HubRelay({ post: () => {}, api: () => fakeApi(async () => ({}), notes), onHostMessage: (m, p) => host.push([m, p]) });
  await relay.handle({ type: 'notify', method: 'ui.addFolder', params: {} });
  await relay.handle({ type: 'notify', method: 'window.status', params: { focused: true } });
  await relay.handle({ type: 'notify', method: 'window.sessionBound', params: { agent: 'claude', sessionId: 'x' } });
  await relay.handle({ type: 'bogus' });
  await relay.handle(null);
  assert.deepEqual(host, [['ui.addFolder', {}]]);
  assert.deepEqual(notes, [['window.status', { focused: true }]]);
});

test('daemon notifications and connection changes are posted; nothing after dispose', () => {
  const posted: HostToWebview[] = [];
  const relay = new HubRelay({ post: (m) => posted.push(m), api: () => undefined, onHostMessage: () => {} });
  relay.notifyFromDaemon('state.changed', { topics: ['folders'] });
  relay.connectionChanged(true);
  relay.dispose();
  relay.connectionChanged(false);
  assert.deepEqual(posted, [
    { type: 'notify', method: 'state.changed', params: { topics: ['folders'] } },
    { type: 'connection', connected: true },
  ]);
});

test('hub html: CSP, webview transport, nonce script', () => {
  const html = hubHtml({ cspSource: 'https://x.vscode-cdn.net', scriptUri: 'https://x/hub-ui.js', styleUri: 'https://x/hub-ui.css', nonce: 'N1' });
  assert.match(html, /<body data-transport="webview">/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-N1' https:\/\/x\.vscode-cdn\.net/);
  assert.match(html, /<script nonce="N1" src="https:\/\/x\/hub-ui\.js"><\/script>/);
  assert.match(html, /<html lang="en">/);
  assert.match(hubHtml({ cspSource: 'c', nonce: 'n' }), /Could not find the hub window UI bundle/);
  const ko = hubHtml({ cspSource: 'c', nonce: 'n', lang: 'ko', t: koT });
  assert.match(ko, /찾지 못했어요/);
  assert.match(ko, /<html lang="ko">/);
  assert.match(ko, /<title>통합 창<\/title>/);
});

test('webview cannot use the window connection for hello, $/auth or other $/ methods', async () => {
  const posted: HostToWebview[] = [];
  const called: string[] = [];
  const relay = new HubRelay({
    post: (m) => posted.push(m),
    api: () => fakeApi(async (m) => {
      called.push(m);
      return {};
    }),
    onHostMessage: () => {},
  });
  await relay.handle({ type: 'rpc', id: 1, method: 'hello', params: {} });
  await relay.handle({ type: 'rpc', id: 2, method: '$/auth', params: { challenge: 'x' } });
  await relay.handle({ type: 'rpc', id: 3, method: '$/openHub', params: {} });
  await relay.handle({ type: 'rpc', id: 4, method: 'folders.list', params: {} });
  assert.deepEqual(called, ['folders.list']);
  assert.deepEqual(
    posted.slice(0, 3).map((m) => (m.type === 'rpcResult' ? m.error?.code : undefined)),
    [ErrorCode.MethodNotFound, ErrorCode.MethodNotFound, ErrorCode.MethodNotFound],
  );
});
