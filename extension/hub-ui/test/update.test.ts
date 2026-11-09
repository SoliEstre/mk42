// 통합 창 «Mk42 업데이트»(update.ts 화면 로직 + store 동작) — 가짜 전송
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, RpcError, type Mk42UpdateStatus } from '@mark42/protocol';
import { setLanguage } from '../src/i18n.ts';
import { HubStore, UPDATE_REQUEST_TIMEOUT_MS } from '../src/store.ts';
import { compareVersions, formatBytes, isMk42UpdateStatus, updateView } from '../src/update.ts';
import { FakeConnection, FakeTimers, flush } from './fakes.ts';

setLanguage('ko');

const CUR = '2026.1107.90937';
const NEW = '2026.1109.120000';
const AUTO_ON = { download: true, install: false };
const base: Mk42UpdateStatus = { state: 'idle', current: CUR, channel: 'internal', auto: AUTO_ON };

test('updateView: 판마다 글·색·단추', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  let v = updateView(base, undefined, now);
  assert.equal(v.label, `Mk42 ${CUR}`, '확인 전에는 설치된 판만');
  assert.equal(v.tone, 'ok');
  assert.deepEqual([v.canCheck, v.canDownload, v.canInstall], [true, false, false]);
  assert.deepEqual(v.auto, AUTO_ON);

  v = updateView({ ...base, latest: CUR, checkedAt: '2026-11-09T11:58:00Z' }, undefined, now);
  assert.equal(v.label, `최신 · ${CUR}`);
  assert.match(v.title, /마지막 확인: 2분 전/);
  assert.doesNotMatch(v.title, /최신 판/, '같은 판은 «최신 판» 줄을 안 써요');

  v = updateView({ ...base, state: 'available', latest: NEW, size: 278_487_539, notes: '고친 것', auto: { download: false, install: false } }, undefined, now);
  assert.equal(v.label, `새 판 ${NEW}`);
  assert.equal(v.tone, 'new');
  assert.deepEqual([v.canCheck, v.canDownload, v.canInstall], [true, true, false]);
  assert.match(v.title, /최신 판: 2026\.1109\.120000/);
  assert.match(v.title, /크기: 265\.6 MB/);
  assert.match(v.title, /자동 받기 꺼짐/);
  assert.match(v.title, /고친 것$/);

  v = updateView({ ...base, state: 'downloading', latest: NEW, progress: { received: 25, total: 100 } }, undefined, now);
  assert.equal(v.label, '받는 중 25%');
  assert.equal(v.progress, 0.25);
  assert.equal(v.tone, 'busy');
  assert.deepEqual([v.canCheck, v.canDownload, v.canInstall], [false, false, false]);

  v = updateView({ ...base, state: 'ready', latest: NEW }, undefined, now);
  assert.equal(v.label, `설치 준비됨 ${NEW}`);
  assert.deepEqual([v.canCheck, v.canDownload, v.canInstall], [true, false, true]);
  assert.equal(v.progress, undefined);

  v = updateView({ ...base, state: 'installing', latest: NEW }, undefined, now);
  assert.equal(v.label, '업데이트 설치 중…');
  assert.deepEqual([v.canCheck, v.canDownload, v.canInstall], [false, false, false]);

  // 받기에 실패한 새 판은 다시 받을 수 있어요, 확인만 실패했으면(새 판 모름) 받기 없음
  v = updateView({ ...base, state: 'error', latest: NEW, error: 'download failed (download stalled)' }, undefined, now);
  assert.equal(v.tone, 'error');
  assert.deepEqual([v.canCheck, v.canDownload], [true, true]);
  assert.match(v.title, /오류: download failed/);
  v = updateView({ ...base, state: 'error', latest: CUR, error: 'HTTP 401' }, undefined, now);
  assert.equal(v.canDownload, false);
  // 옛 데몬(auto 없음)은 update.download를 몰라요
  v = updateView({ state: 'error', current: CUR, channel: 'internal', latest: NEW, error: 'download failed' }, undefined, now);
  assert.equal(v.canDownload, false);

  v = updateView({ state: 'disabled', current: CUR }, undefined, now);
  assert.equal(v.tone, 'off');
  assert.equal(v.canCheck, false);
  assert.equal(v.auto, undefined, '채널 없는 설치본은 설정 메뉴 없음');
  assert.match(v.title, /업데이트 채널이 없어요/);
});

test('updateView: 기다리는 요청이 있으면 단추를 다 꺼요; 서버 판이 더 낮으면 새 판이 아니에요', () => {
  const v = updateView({ ...base, state: 'ready', latest: NEW }, 'install');
  assert.deepEqual([v.canCheck, v.canDownload, v.canInstall], [false, false, false]);
  const older = updateView({ ...base, state: 'error', latest: '2026.1101.1', error: 'x' });
  assert.equal(older.canDownload, false);
  assert.doesNotMatch(older.title, /최신 판/);
  assert.ok(compareVersions('2026.1109.1', '2026.1107.90937') > 0);
  assert.ok(compareVersions('2026.1107.90937', '2026.1107.100000') < 0, '마디는 숫자로 비교');
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(formatBytes(278_487_539), '265.6 MB');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(undefined), '');
  assert.equal(isMk42UpdateStatus({ state: 'available', current: CUR }), true);
  assert.equal(isMk42UpdateStatus({ state: 'weird', current: CUR }), false);
  assert.equal(isMk42UpdateStatus({}), false);
});

function makeStore(status: Mk42UpdateStatus | Error = base) {
  const conn = new FakeConnection();
  let current: Mk42UpdateStatus | Error = status;
  conn
    .on('folders.list', () => [])
    .on('windows.list', () => [])
    .on('pinned.list', () => [])
    .on('autostart.get', () => ({ enabled: false, method: 'taskScheduler', taskName: 't' }))
    .on('update.status', () => {
      if (current instanceof Error) throw current;
      return current;
    });
  const errors: string[] = [];
  const infos: string[] = [];
  const store = new HubStore(conn, { timers: new FakeTimers(), onError: (m) => errors.push(m), onInfo: (m) => infos.push(m) });
  return {
    conn,
    store,
    errors,
    infos,
    set(s: Mk42UpdateStatus | Error) {
      current = s;
    },
  };
}

test('store: 연결되면 update.status를 읽고, 옛 데몬(MethodNotFound)이면 숨겨요(토스트 없이)', async () => {
  const a = makeStore();
  const kinds: string[] = [];
  a.store.onChange((k) => kinds.push(...k));
  a.store.start();
  await flush(20);
  assert.equal(a.conn.count('update.status'), 1);
  assert.equal(a.store.data.update?.current, CUR);
  assert.ok(kinds.includes('update'));

  const b = makeStore(new RpcError(ErrorCode.MethodNotFound, 'method not found: update.status'));
  b.store.start();
  await flush(20);
  assert.equal(b.store.data.update, undefined);
  assert.deepEqual(b.errors, []);
});

test('store: update.changed로 상태를 바꾸고, ready가 되면 한 번만 알려요(announce는 떼어 내요)', async () => {
  const { conn, store, infos } = makeStore();
  store.start();
  await flush(20);
  conn.emitNotification('update.changed', { ...base, state: 'downloading', latest: NEW, progress: { received: 1, total: 2 } });
  assert.equal(store.data.update?.state, 'downloading');
  conn.emitNotification('update.changed', { ...base, state: 'ready', latest: NEW, announce: true });
  assert.equal(store.data.update?.state, 'ready');
  assert.equal((store.data.update as { announce?: boolean }).announce, undefined);
  assert.deepEqual(infos, [`새 판을 받았어요: ${NEW} — 오른쪽 위 «설치»를 눌러 주세요`]);
  // 같은 판 ready 알림이 또 와도(진행·설정 바뀜) 다시 알리지 않아요
  conn.emitNotification('update.changed', { ...base, state: 'checking', latest: NEW });
  conn.emitNotification('update.changed', { ...base, state: 'ready', latest: NEW });
  assert.equal(infos.length, 1);
  // 이상한 값은 버려요
  conn.emitNotification('update.changed', { state: 'weird' });
  assert.equal(store.data.update?.state, 'ready');
});

test('store: 처음 읽은 상태가 이미 ready면 알리지 않아요(머리 줄로 보여요)', async () => {
  const { conn, store, infos } = makeStore({ ...base, state: 'ready', latest: NEW });
  store.start();
  await flush(20);
  conn.emitNotification('update.changed', { ...base, state: 'ready', latest: NEW });
  assert.deepEqual(infos, []);
});

test('store: 확인 — 90초 한도, 결과에 따라 알림; 기다리는 동안 busy', async () => {
  const { conn, store, infos, errors } = makeStore();
  store.start();
  await flush(20);
  let answer: Mk42UpdateStatus = { ...base, latest: CUR, checkedAt: '2026-11-09T12:00:00Z' };
  let release!: () => void;
  conn.on('update.check', () => new Promise((r) => (release = () => r(answer))));
  const p = store.checkUpdate();
  assert.equal(store.data.updateBusy, 'check');
  void store.checkUpdate(); // 두 번 눌러도 요청은 하나
  await flush();
  release();
  await p;
  assert.equal(conn.count('update.check'), 1);
  assert.equal(conn.requests.find((r) => r.method === 'update.check')?.timeoutMs, UPDATE_REQUEST_TIMEOUT_MS);
  assert.equal(store.data.updateBusy, undefined);
  assert.equal(infos.at(-1), `Mk42가 최신이에요 (${CUR})`);

  answer = { ...base, state: 'available', latest: NEW, auto: { download: false, install: false } };
  conn.on('update.check', () => answer);
  await store.checkUpdate();
  assert.equal(infos.at(-1), `새 판이 나왔어요: ${NEW}`);
  answer = { ...base, state: 'error', error: 'HTTP 401 (check update.secret)' };
  await store.checkUpdate();
  assert.equal(errors.at(-1), '업데이트 확인: HTTP 401 (check update.secret)');
  conn.on('update.check', () => ({}));
  const restore = console.error;
  console.error = () => {};
  try {
    await store.checkUpdate();
  } finally {
    console.error = restore;
  }
  assert.match(errors.at(-1) ?? '', /업데이트 확인: .*지원하지 않아요/);
});

test('store: 받기·설치·설정', async () => {
  const { conn, store, infos, errors } = makeStore({ ...base, state: 'available', latest: NEW, auto: { download: false, install: false } });
  store.start();
  await flush(20);
  conn.on('update.download', () => ({ ...base, state: 'downloading', latest: NEW, progress: { received: 0, total: 9 } }));
  await store.downloadUpdate();
  assert.equal(store.data.update?.state, 'downloading');
  assert.equal(infos.at(-1), `새 판을 받는 중이에요: ${NEW}`);

  conn.on('update.install', () => ({ started: true }));
  await store.installUpdate();
  assert.equal(infos.at(-1), '업데이트를 설치하고 있어요. 창은 닫히지 않고 데몬만 다시 떠요');
  conn.on('update.install', () => ({ started: false, error: 'no downloaded update is ready' }));
  await store.installUpdate();
  assert.equal(errors.at(-1), '업데이트 설치: no downloaded update is ready');

  conn.on('update.setAuto', (p) => ({ ...base, state: 'downloading', latest: NEW, auto: { download: true, install: false, ...(p as object) } }));
  await store.setUpdateAuto({ download: true });
  assert.deepEqual(conn.requests.filter((r) => r.method === 'update.setAuto').map((r) => r.params), [{ download: true }]);
  assert.equal(store.data.update?.auto?.download, true);

  // 실패하면 알리고 데몬 값으로 다시 읽어요
  const before = conn.count('update.status');
  conn.on('update.setAuto', () => {
    throw new RpcError(ErrorCode.InvalidParams, 'install must be boolean');
  });
  const restore = console.error;
  console.error = () => {};
  try {
    await store.setUpdateAuto({ install: true });
  } finally {
    console.error = restore;
  }
  await flush(10);
  assert.match(errors.at(-1) ?? '', /^업데이트 설정: /);
  assert.equal(conn.count('update.status'), before + 1);
});

test('store: 요청을 보낸 뒤 온 update.changed가 더 새것 — 늦게 온 응답으로 덮지 않아요', async () => {
  const { conn, store } = makeStore();
  store.start();
  await flush(20);
  let release!: () => void;
  conn.on('update.check', () => new Promise((r) => (release = () => r({ ...base, state: 'checking' }))));
  const p = store.checkUpdate();
  await flush();
  conn.emitNotification('update.changed', { ...base, state: 'downloading', latest: NEW, progress: { received: 1, total: 9 } });
  release();
  await p;
  assert.equal(store.data.update?.state, 'downloading');
});

test('store: ⚙ 체크는 누른 값이 바로 보이고(응답 전), 실패하면 데몬 값으로', async () => {
  const { conn, store } = makeStore({ ...base, auto: { download: true, install: false } });
  store.start();
  await flush(20);
  let release!: () => void;
  conn.on('update.setAuto', () => new Promise((r) => (release = () => r({ ...base, auto: { download: false, install: false } }))));
  const p = store.setUpdateAuto({ download: false });
  assert.equal(store.data.update?.auto?.download, false, '응답 전에도 누른 값');
  assert.equal(store.data.updateBusy, 'auto');
  release();
  await p;
  assert.equal(store.data.update?.auto?.download, false);
  assert.equal(conn.requests.find((r) => r.method === 'update.setAuto')?.timeoutMs, UPDATE_REQUEST_TIMEOUT_MS);
});
