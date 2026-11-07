import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setOsUiLanguageForTest } from '../src/i18n.ts';
import { busyMessage, setupLanguage, setupText, SetupUserError } from '../src/setup/messages.ts';

test('setup busy message: Korean keeps the wizard wording, English is plain', () => {
  const list = [
    { Name: 'mk42-hub.exe', ExecutablePath: 'C:\\h\\hub\\mk42-hub.exe' },
    { Name: 'Mk42.exe', ExecutablePath: null },
    { Name: 'MK42.EXE', ExecutablePath: 'C:\\h\\app\\x\\Mk42.exe' },
  ];
  assert.equal(
    busyMessage('ko', list),
    '열려 있는 프로그램이 있어요: 통합 창(mk42-hub), Mk42 창 — 모두 닫고 다시 제거해 주세요(창을 대신 닫지 않아요). 관리자 권한으로 띄운 창일 수도 있어요.',
  );
  assert.equal(
    busyMessage('en', list.slice(0, 1)),
    'Some programs are still open: hub window (mk42-hub) — close them all and uninstall again (setup does not close windows for you).',
  );
});

test('setup text fills placeholders and every key has both languages', () => {
  assert.equal(setupText('ko', 'notRemoved', 'C:\\h\\app'), '일부 파일을 지우지 못했어요(사용 중?): C:\\h\\app — 직접 지워 주세요');
  assert.match(setupText('en', 'daemonNotStarted', 'C:\\h\\logs\\mk42d.log'), /30 seconds — see C:\\h\\logs\\mk42d\.log$/);
  const keys = ['notHome', 'busy', 'busyElevated', 'hubWindow', 'mk42Window', 'elevatedInstall', 'elevatedUninstall', 'daemonNotStopped', 'daemonNotStarted', 'notRemoved', 'shortcutDescription'] as const;
  for (const k of keys) {
    assert.notEqual(setupText('ko', k), k);
    assert.notEqual(setupText('en', k), k);
    assert.notEqual(setupText('ko', k), setupText('en', k));
  }
});

test('setup language: --lang wins over the Windows UI language', async () => {
  setOsUiLanguageForTest('en');
  try {
    assert.equal(await setupLanguage('ko'), 'ko');
    assert.equal(await setupLanguage('ko-KR'), 'ko');
    assert.equal(await setupLanguage('en'), 'en');
    assert.equal(await setupLanguage(undefined), 'en');
    setOsUiLanguageForTest('ko');
    assert.equal(await setupLanguage(undefined), 'ko');
  } finally {
    setOsUiLanguageForTest(undefined);
  }
});

test('SetupUserError keeps the English log message apart from the user text', () => {
  const e = new SetupUserError('could not stop', '끄지 못했어요');
  assert.equal(e.message, 'could not stop');
  assert.equal(e.userText, '끄지 못했어요');
  assert.ok(e instanceof Error);
});
