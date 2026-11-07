// Mk42 자체 업데이트 알림(mk42Update.ts) — 가짜 vscode + 가짜 데몬 클라이언트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(join(here, 'helpers', 'vscode-stub.ts')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true, format: 'module' };
    return next(specifier, context);
  },
});
const vs = (await import(stubUrl)) as typeof import('./helpers/vscode-stub.ts');
const { Mk42UpdateNotifier, MK42_UPDATE_CHECK_COMMAND, MK42_UPDATE_PROMPT_COMMAND, isMk42UpdateStatus } = (await import(
  '../src/mk42Update.ts'
)) as typeof import('../src/mk42Update.ts');

const silent = { info() {}, warn() {}, error() {}, debug() {}, show() {} };
const tick = () => new Promise((r) => setTimeout(r, 10));

function fakeDaemon(answers: Record<string, unknown | ((p: unknown) => unknown)>) {
  const notif = new Set<(m: string, p: unknown) => void>();
  const states = new Set<(s: string) => void>();
  const requests: [string, unknown][] = [];
  const api = {
    request: async (method: string, params: unknown) => {
      requests.push([method, params]);
      const a = answers[method];
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : a;
    },
    notify() {},
    onNotification: () => () => undefined,
  };
  return {
    requests,
    connected: true,
    daemon: {
      get api() {
        return api as never;
      },
      onNotification: (cb: (m: string, p: unknown) => void) => {
        notif.add(cb);
        return { dispose: () => notif.delete(cb) };
      },
      onStateChange: (cb: (s: string) => void) => {
        states.add(cb);
        return { dispose: () => states.delete(cb) };
      },
    },
    push(method: string, params: unknown) {
      for (const cb of notif) cb(method, params);
    },
    state(s: string) {
      for (const cb of states) cb(s);
    },
  };
}

const READY = { state: 'ready', current: '2026.1101.100000', latest: '2026.1105.143012', channel: 'internal' };

test('mk42 update: the announced window asks once (Korean texts), «설치» calls update.install; other windows only show the status bar item', async () => {
  vs.reset();
  const d = fakeDaemon({ 'update.status': { state: 'idle', current: '2026.1101.100000' }, 'update.install': { started: true } });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await tick();
  const item = vs.state.statusItems.at(-1)!;
  assert.equal(item.visible, false);
  vs.state.answers.push('설치');
  d.push('update.changed', { ...READY, announce: true });
  await tick();
  assert.equal(item.visible, true);
  assert.equal(item.text, '$(cloud-download) Mk42 2026.1105.143012');
  assert.equal(item.command, MK42_UPDATE_PROMPT_COMMAND);
  assert.deepEqual(vs.state.messages, [{ level: 'info', text: 'Mk42 업데이트 2026.1105.143012를 받았어요. 지금 설치할까요? (열린 창은 닫히지 않아요)' }]);
  assert.ok(d.requests.some(([m]) => m === 'update.install'));
  // 같은 판을 다시 announce해도 다시 묻지 않아요
  d.push('update.changed', { ...READY, announce: true });
  await tick();
  assert.equal(vs.state.messages.length, 1);
  // announce 없는 알림은 묻지 않아요
  d.push('update.changed', { ...READY, latest: '2026.1106.1' });
  await tick();
  assert.equal(vs.state.messages.length, 1);
  assert.equal(item.text, '$(cloud-download) Mk42 2026.1106.1');
  d.push('update.changed', { state: 'installing', current: READY.current, latest: '2026.1106.1' });
  assert.equal(item.visible, false);
  assert.equal(vs.state.l10nMissing.size, 0, [...vs.state.l10nMissing].join(' | '));
  n.dispose();
});

test('mk42 update: «나중에» does not install; the status bar button asks again', async () => {
  vs.reset();
  const d = fakeDaemon({ 'update.status': READY, 'update.install': { started: true } });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await tick();
  assert.equal(vs.state.statusItems.at(-1)!.visible, true, 'ready from update.status on start');
  assert.equal(vs.state.messages.length, 0, 'update.status alone never asks');
  vs.state.answers.push('나중에');
  await vs.commands.executeCommand(MK42_UPDATE_PROMPT_COMMAND);
  assert.ok(!d.requests.some(([m]) => m === 'update.install'));
  vs.state.answers.push('설치');
  await vs.commands.executeCommand(MK42_UPDATE_PROMPT_COMMAND);
  assert.ok(d.requests.some(([m]) => m === 'update.install'));
  n.dispose();
});

test('mk42 update: check command reports up to date / errors / failed install start', async () => {
  vs.reset();
  let check: unknown = { state: 'idle', current: '2026.1101.100000', latest: '2026.1101.100000' };
  const d = fakeDaemon({ 'update.status': {}, 'update.check': () => check, 'update.install': { started: false, error: 'boom' } });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await vs.commands.executeCommand(MK42_UPDATE_CHECK_COMMAND);
  assert.equal(vs.state.messages.at(-1)!.text, 'Mk42가 최신이에요 (2026.1101.100000)');
  check = { state: 'error', current: '2026.1101.100000', error: 'HTTP 401' };
  await vs.commands.executeCommand(MK42_UPDATE_CHECK_COMMAND);
  assert.equal(vs.state.messages.at(-1)!.text, '업데이트를 확인하지 못했어요: HTTP 401');
  check = {}; // 옛 데몬
  await vs.commands.executeCommand(MK42_UPDATE_CHECK_COMMAND);
  assert.equal(vs.state.messages.at(-1)!.level, 'warn');
  check = READY;
  vs.state.answers.push('설치');
  await vs.commands.executeCommand(MK42_UPDATE_CHECK_COMMAND);
  assert.equal(vs.state.messages.at(-1)!.level, 'error');
  assert.match(vs.state.messages.at(-1)!.text, /boom/);
  assert.equal(vs.state.l10nMissing.size, 0, [...vs.state.l10nMissing].join(' | '));
  n.dispose();
});

test('isMk42UpdateStatus rejects junk from old daemons', () => {
  assert.equal(isMk42UpdateStatus({}), false);
  assert.equal(isMk42UpdateStatus(null), false);
  assert.equal(isMk42UpdateStatus({ state: 'weird', current: 'x' }), false);
  assert.equal(isMk42UpdateStatus({ state: 'idle', current: 'x' }), true);
});
