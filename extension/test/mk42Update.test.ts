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
const { Mk42UpdateNotifier, MK42_UPDATE_CHECK_COMMAND, MK42_UPDATE_PROMPT_COMMAND, MK42_APP_RESTART_COMMAND, isMk42UpdateStatus } = (await import(
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

test('mk42 update: available (auto download off) shows $(cloud), the button asks «받을까요?», «받기» calls update.download', async () => {
  vs.reset();
  const AVAILABLE = { ...READY, state: 'available', auto: { download: false, install: false } };
  let download: unknown = { ...AVAILABLE, state: 'downloading', progress: { received: 0, total: 10 } };
  const d = fakeDaemon({ 'update.status': AVAILABLE, 'update.download': () => download });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await tick();
  const item = vs.state.statusItems.at(-1)!;
  assert.equal(item.visible, true);
  assert.equal(item.text, '$(cloud) Mk42 2026.1105.143012');
  vs.state.answers.push('나중에');
  await vs.commands.executeCommand(MK42_UPDATE_PROMPT_COMMAND);
  assert.equal(vs.state.messages.at(-1)!.text, 'Mk42 업데이트 2026.1105.143012가 나왔어요. 지금 받을까요?');
  assert.ok(!d.requests.some(([m]) => m === 'update.download'));
  vs.state.answers.push('받기');
  await vs.commands.executeCommand(MK42_UPDATE_PROMPT_COMMAND);
  assert.ok(d.requests.some(([m]) => m === 'update.download'));
  assert.equal(vs.state.messages.at(-1)!.text, 'Mk42 업데이트 2026.1105.143012를 받는 중이에요…');
  assert.equal(item.visible, false, 'downloading hides the item');
  download = { ...AVAILABLE, state: 'error', error: 'HTTP 404' };
  d.push('update.changed', AVAILABLE);
  vs.state.answers.push('받기');
  await vs.commands.executeCommand(MK42_UPDATE_PROMPT_COMMAND);
  assert.equal(vs.state.messages.at(-1)!.level, 'error');
  assert.match(vs.state.messages.at(-1)!.text, /HTTP 404/);
  assert.equal(vs.state.l10nMissing.size, 0, [...vs.state.l10nMissing].join(' | '));
  n.dispose();
});

test('isMk42UpdateStatus rejects junk from old daemons', () => {
  assert.equal(isMk42UpdateStatus({}), false);
  assert.equal(isMk42UpdateStatus(null), false);
  assert.equal(isMk42UpdateStatus({ state: 'weird', current: 'x' }), false);
  assert.equal(isMk42UpdateStatus({ state: 'idle', current: 'x' }), true);
  assert.equal(isMk42UpdateStatus({ state: 'available', current: 'x' }), true);
});

// «다시 시작해서 적용»(교훈 012) — 데몬 상태의 appRestart → 상태 표시줄, 모달 확인 뒤 app.restartToUpdate, app.quitForUpdate → 앱 끝내기
const IDLE = { state: 'idle', current: '2026.1117.1' };
const restartItem = () => vs.state.statusItems.find((i) => i.id === 'mark42.mk42AppRestart')!;
/** 이 창의 앱 이름(vscode.env.appName) — 단추는 Mk42 창에만 보여요 */
const setAppName = (name: string) => ((vs.env as { appName: string }).appName = name);

test('app restart: the status bar item appears with appRestart; clicking asks a modal first, «취소» does nothing, «다시 시작» calls app.restartToUpdate', async () => {
  vs.reset();
  setAppName('Mark42');
  const d = fakeDaemon({ 'update.status': { ...IDLE, appRestart: { running: '1.143.1', available: '1.146.0' } }, 'app.restartToUpdate': { started: true, windows: 3 } });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await tick();
  const item = restartItem();
  assert.equal(item.visible, true);
  assert.equal(item.text, '$(sync) Mk42 1.146.0 — 다시 시작해서 적용');
  assert.equal(item.command, MK42_APP_RESTART_COMMAND);
  assert.match(String(item.tooltip), /1\.143\.1/);
  assert.equal(vs.state.statusItems.find((i) => i.id === 'mark42.mk42Update')!.visible, false, 'the update item is separate');
  assert.equal(vs.state.messages.length, 0, 'never asks by itself');

  vs.state.answers.push(undefined); // 모달 닫기
  await vs.commands.executeCommand(MK42_APP_RESTART_COMMAND);
  assert.equal(vs.state.messages.at(-1)!.level, 'warn');
  assert.equal(vs.state.messages.at(-1)!.text, 'Mk42를 다시 시작해서 1.146.0를 적용할까요?');
  assert.ok(!d.requests.some(([m]) => m === 'app.restartToUpdate'), 'no restart without consent');

  vs.state.answers.push('다시 시작');
  await vs.commands.executeCommand(MK42_APP_RESTART_COMMAND);
  assert.deepEqual(d.requests.find(([m]) => m === 'app.restartToUpdate'), ['app.restartToUpdate', { available: '1.146.0' }]);
  assert.equal(vs.state.messages.length, 2, 'no error after a started restart');

  // 진행 중: 돌아가는 아이콘, 누를 수 없어요
  d.push('update.changed', { ...IDLE, appRestart: { running: '1.143.1', available: '1.146.0', restarting: true } });
  assert.equal(item.text, '$(sync~spin) Mk42를 1.146.0로 다시 시작하는 중이에요…');
  assert.equal(item.command, undefined);
  await vs.commands.executeCommand(MK42_APP_RESTART_COMMAND);
  assert.equal(vs.state.messages.length, 2, 'no second question while restarting');
  // 멈췄으면 경고 아이콘 + 이유, 다시 누를 수 있어요
  d.push('update.changed', { ...IDLE, appRestart: { running: '1.143.1', available: '1.146.0', failed: 'timeout', error: 'Mk42 1.143.1 did not close within 90 s' } });
  assert.equal(item.text, '$(warning) Mk42 1.146.0 — 다시 시작해서 적용');
  assert.match(String(item.tooltip), /did not close within 90 s/);
  assert.equal(item.command, MK42_APP_RESTART_COMMAND);
  // 끝나면 사라져요
  d.push('update.changed', IDLE);
  assert.equal(item.visible, false);
  assert.equal(vs.state.l10nMissing.size, 0, [...vs.state.l10nMissing].join(' | '));
  n.dispose();
  setAppName('Visual Studio Code');
});

test('app restart: the daemon refusing or not knowing the method shows an error', async () => {
  vs.reset();
  setAppName('Mark42');
  let answer: unknown = { started: false, error: 'no open Mk42 window runs an older app version' };
  const d = fakeDaemon({ 'update.status': { ...IDLE, appRestart: { running: '1.143.1', available: '1.146.0' } }, 'app.restartToUpdate': () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await tick();
  vs.state.answers.push('다시 시작');
  await vs.commands.executeCommand(MK42_APP_RESTART_COMMAND);
  assert.equal(vs.state.messages.at(-1)!.level, 'error');
  assert.equal(vs.state.messages.at(-1)!.text, 'Mk42를 다시 시작하지 못했어요: no open Mk42 window runs an older app version');
  answer = new Error('MethodNotFound');
  vs.state.answers.push('다시 시작');
  await vs.commands.executeCommand(MK42_APP_RESTART_COMMAND);
  assert.match(vs.state.messages.at(-1)!.text, /MethodNotFound/);
  // 연결이 끊기면 숨겨요(다시 붙으면 새 상태)
  d.state('disconnected');
  assert.equal(restartItem().visible, false);
  assert.equal(vs.state.l10nMissing.size, 0, [...vs.state.l10nMissing].join(' | '));
  n.dispose();
  setAppName('Visual Studio Code');
});

test('app restart: only Mk42 windows show the item — an official VS Code window with the same extension does not', async () => {
  vs.reset();
  setAppName('Visual Studio Code');
  const d = fakeDaemon({ 'update.status': { ...IDLE, appRestart: { running: '1.143.1', available: '1.146.0' } } });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await tick();
  assert.equal(restartItem().visible, false);
  setAppName('Mark42');
  d.push('update.changed', { ...IDLE, appRestart: { running: '1.143.1', available: '1.146.0' } });
  assert.equal(restartItem().visible, true);
  n.dispose();
  setAppName('Visual Studio Code');
});

test('app restart: old windows that all run an older Mark42 extension (needsReload) — warning icon, the click says to reload or close them and sends nothing (C11)', async () => {
  vs.reset();
  setAppName('Mark42');
  const d = fakeDaemon({
    'update.status': { ...IDLE, appRestart: { running: '1.143.1', available: '1.146.0', needsReload: ['1.143.1'] } },
    'app.restartToUpdate': { started: true, windows: 1 },
  });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await tick();
  const item = restartItem();
  assert.equal(item.visible, true);
  assert.equal(item.text, '$(warning) Mk42 1.146.0 — 다시 시작해서 적용');
  assert.match(String(item.tooltip), /창 다시 로드/);
  await vs.commands.executeCommand(MK42_APP_RESTART_COMMAND);
  assert.deepEqual(vs.state.messages, [
    {
      level: 'warn',
      text: 'Mk42 1.143.1 창은 다시 시작을 모르는 옛 Mark42 확장으로 돌아요. 그 창 하나를 다시 로드하거나(개발자: 창 다시 로드) 직접 닫은 뒤 다시 해 보세요.',
    },
  ]);
  assert.ok(!d.requests.some(([m]) => m === 'app.restartToUpdate'), 'no restart request');
  assert.equal(vs.state.l10nMissing.size, 0, [...vs.state.l10nMissing].join(' | '));
  n.dispose();
  setAppName('Visual Studio Code');
});

test('app.quitForUpdate: quits the app only in a window of that version', async () => {
  vs.reset();
  const d = fakeDaemon({ 'update.status': IDLE });
  const n = new Mk42UpdateNotifier(d.daemon as never, silent);
  await tick();
  d.push('app.quitForUpdate', { appVersion: '1.141.0', nextVersion: '1.146.0' });
  await tick();
  assert.ok(!vs.state.executed.some((e) => e.id === 'workbench.action.quit'), 'another version ignores it');
  d.push('app.quitForUpdate', { appVersion: vs.version, nextVersion: '1.146.0' });
  await tick();
  assert.ok(vs.state.executed.some((e) => e.id === 'workbench.action.quit'));
  assert.equal(vs.state.messages.length, 0, 'the daemon only sends this after the user confirmed');
  n.dispose();
});
