import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABORTED_EXIT,
  escapeSendKeys,
  FOREGROUND_MISMATCH_EXIT,
  parseReadyLine,
  powershellArgs,
  sendKeysHandshakeScript,
  sendKeysScript,
  type CommandResult,
  type InteractiveProcess,
} from '../src/lib/sendkeys.ts';
import { OsKeySender } from '../src/sender.ts';

test('escapeSendKeys wraps special characters', () => {
  assert.equal(escapeSendKeys('a+b^c%d~(e){f}[g]'), 'a{+}b{^}c{%}d{~}{(}e{)}{{}f{}}{[}g{]}');
  assert.equal(escapeSendKeys('한글 /effort high'), '한글 /effort high');
});

test('script guards foreground pid and quotes keys', () => {
  const s = sendKeysScript("{ENTER}'", 1234);
  assert.match(s, /if \(\$fgPid -ne 1234\)/);
  assert.match(s, /SendWait\('\{ENTER\}'''\)/);
  assert.doesNotMatch(sendKeysScript('{ENTER}'), /GetForegroundWindow/);
  assert.throws(() => sendKeysScript('{ENTER}', -1));
});

test('handshake script: READY line, waits for GO <hwnd>, re-checks hwnd and pid right before SendWait', () => {
  const s = sendKeysHandshakeScript('{ENTER}', 4321);
  assert.match(s, /M42READY /);
  assert.match(s, /\[Console\]::In\.ReadLine\(\)/);
  assert.match(s, /\^GO \(\\d\+\)\$/);
  assert.match(s, /if \(\$h -ne \$want -or \$p -ne 4321\)/);
  assert.ok(s.indexOf('$want') < s.indexOf('SendWait'), 'hwnd check comes before the keystroke');
  assert.ok(s.includes(`exit ${ABORTED_EXIT}`) && s.includes(`exit ${FOREGROUND_MISMATCH_EXIT}`));
  assert.doesNotMatch(sendKeysHandshakeScript('{ENTER}'), /-or \$p -ne/);
  assert.deepEqual(parseReadyLine('M42READY 66350 478452\r'), { hwnd: 66350, pid: 478452 });
  assert.equal(parseReadyLine('garbage'), undefined);
});

test('powershell args use UTF-16LE encoded command', () => {
  const args = powershellArgs('Write-Output 한');
  assert.equal(args[args.length - 2], '-EncodedCommand');
  assert.equal(Buffer.from(args[args.length - 1]!, 'base64').toString('utf16le'), 'Write-Output 한');
  assert.ok(args.includes('-NoProfile'));
});

// ---- OsKeySender (가짜 PowerShell)

const silent = { info() {}, warn() {}, error() {}, debug() {}, show() {} };

function fakeShell(fg: () => { hwnd: number; pid: number }) {
  const writes: string[] = [];
  let runs = 0;
  const spawner = (): InteractiveProcess => {
    runs++;
    const listeners: ((l: string) => void)[] = [];
    let resolve: (r: CommandResult) => void = () => undefined;
    const done = new Promise<CommandResult>((r) => {
      resolve = r;
    });
    setImmediate(() => {
      const f = fg();
      for (const cb of listeners) cb(`M42READY ${f.hwnd} ${f.pid}`);
    });
    return {
      onLine: (cb) => void listeners.push(cb),
      write: (line) => {
        writes.push(line);
        const m = /^GO (\d+)$/.exec(line);
        if (!m) return resolve({ code: ABORTED_EXIT, stdout: '', stderr: '' });
        const now = fg();
        if (now.hwnd !== Number(m[1]) || now.pid !== 500) resolve({ code: FOREGROUND_MISMATCH_EXIT, stdout: `foreground=${now.hwnd}:${now.pid}`, stderr: '' });
        else resolve({ code: 0, stdout: '', stderr: '' });
      },
      done,
      kill: () => resolve({ code: null, stdout: '', stderr: '' }),
    };
  };
  return { spawner, writes, runs: () => runs };
}

test('sender: learns this window’s HWND while focused, then refuses another VS Code window with the same main pid', async () => {
  let fg = { hwnd: 11, pid: 500 };
  let focused = true;
  const sh = fakeShell(() => fg);
  const sender = new OsKeySender(silent, { spawner: sh.spawner, expectedPid: 500, isFocused: () => focused, platform: 'win32', sleep: async () => {} });
  assert.deepEqual(await sender.enter(), { ok: true, detail: 'sent' });
  assert.equal(sender.ownHwnd, 11);
  assert.deepEqual(sh.writes, ['GO 11']);

  // 다른 Mark42 창(같은 Code.exe → 같은 pid)이 앞에 왔는데 이 창의 포커스 이벤트가 아직 안 온 경우
  fg = { hwnd: 22, pid: 500 };
  const r = await sender.enter();
  assert.equal(r.ok, false);
  assert.match(r.detail, /another window/);
  assert.equal(sh.writes.at(-1), 'ABORT');

  // 포커스가 없으면 보내지 않아요
  focused = false;
  fg = { hwnd: 11, pid: 500 };
  assert.match((await sender.enter()).detail, /lost focus/);
  // 다른 앱
  focused = true;
  fg = { hwnd: 33, pid: 9 };
  assert.match((await sender.enter()).detail, /not this app/);
  assert.ok(sh.writes.slice(1).every((w) => w === 'ABORT'));
});

test('sender: focus moving between the check and the keystroke is caught by the script', async () => {
  let n = 0;
  const sh = fakeShell(() => (n++ === 0 ? { hwnd: 11, pid: 500 } : { hwnd: 44, pid: 500 }));
  const sender = new OsKeySender(silent, { spawner: sh.spawner, expectedPid: 500, isFocused: () => true, platform: 'win32', sleep: async () => {} });
  const r = await sender.enter();
  assert.equal(r.ok, false);
  assert.match(r.detail, /foreground changed before send/);
});

test('sender: non-Windows is unavailable', async () => {
  const sender = new OsKeySender(silent, { platform: 'linux' });
  assert.equal(sender.available, false);
  assert.equal((await sender.enter()).ok, false);
});
