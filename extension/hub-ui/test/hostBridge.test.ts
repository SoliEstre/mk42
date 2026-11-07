// 통합 창 exe(WebView2)의 폴더 선택 다리, 최근 폴더 목록
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canPickFolder, isAbsoluteWinPath, looksLikeRepoAddress, pickFolder, pushRecentFolder, type HostBridgeGlobal, type WebViewLike } from '../src/host-bridge.ts';

function fakeHost(answer: (msg: { id: number; title: string; initial?: string }) => string | null): { g: HostBridgeGlobal; sent: unknown[] } {
  const listeners = new Set<(ev: { data: unknown }) => void>();
  const sent: unknown[] = [];
  const webview: WebViewLike = {
    postMessage(m) {
      sent.push(m);
      const msg = m as { id: number; title: string; initial?: string };
      setTimeout(() => {
        // an unrelated message first, then the answer
        for (const l of [...listeners]) l({ data: { type: 'pickFolderResult', id: msg.id + 1000, path: 'D:\\wrong' } });
        for (const l of [...listeners]) l({ data: { type: 'pickFolderResult', id: msg.id, path: answer(msg) } });
      }, 1);
    },
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  return { g: { mk42HubHost: { pickFolder: 1 }, chrome: { webview } }, sent };
}

test('pick folder: only inside the Mk42 hub exe; the answer with the same id wins', async () => {
  assert.equal(canPickFolder({}), false);
  assert.equal(canPickFolder({ chrome: { webview: fakeHost(() => null).g.chrome!.webview! } }), false, 'a WebView2 without the marker (old exe)');
  assert.equal(await pickFolder({ title: 't' }, {}), null);

  const { g, sent } = fakeHost((m) => (m.title === 'cancel' ? null : `C:\\Dev\\${m.id}`));
  assert.equal(canPickFolder(g), true);
  const a = await pickFolder({ title: '클론할 위치', initial: 'C:\\Dev' }, g);
  assert.match(a!, /^C:\\Dev\\\d+$/);
  assert.deepEqual(Object.keys(sent[0] as object).sort(), ['id', 'initial', 'title', 'type']);
  assert.equal(await pickFolder({ title: 'cancel' }, g), null);
});

test('recent folders: newest first, one entry per folder, at most ten', () => {
  let list: string[] = [];
  list = pushRecentFolder(list, 'C:\\Dev\\a');
  list = pushRecentFolder(list, 'C:\\Dev\\b');
  list = pushRecentFolder(list, 'c:\\dev\\A\\');
  assert.deepEqual(list, ['c:\\dev\\A\\', 'C:\\Dev\\b']);
  for (let i = 0; i < 15; i++) list = pushRecentFolder(list, `D:\\x${i}`);
  assert.equal(list.length, 10);
  assert.equal(list[0], 'D:\\x14');
  assert.deepEqual(pushRecentFolder(list, '  '), list);
});

test('address-looking text and absolute Windows paths', () => {
  assert.equal(looksLikeRepoAddress('https://user:tok@github.com/o/r'), true);
  assert.equal(looksLikeRepoAddress('git@host:o/r'), true);
  assert.equal(looksLikeRepoAddress('C:\\Dev\\x'), false);
  assert.equal(isAbsoluteWinPath('C:\\Dev'), true);
  assert.equal(isAbsoluteWinPath('\\\\server\\share'), true);
  assert.equal(isAbsoluteWinPath('Dev\\x'), false);
});
