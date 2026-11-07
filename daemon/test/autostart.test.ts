import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  Autostart,
  buildCreateArgs,
  buildDeleteArgs,
  buildQueryArgs,
  buildTaskXml,
  currentUserId,
  parseQueryResult,
  parseTaskAction,
  LEGACY_TASK_NAME,
  quoteArg,
  splitTaskArguments,
  TASK_NAME,
  type CommandResult,
  type TaskAction,
} from '../src/autostart.ts';
import { tempDir } from './helpers.ts';

const ACTION = {
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:\\Dev\\work area\\Mark42\\mark42\\daemon\\dist\\mk42d.mjs', '--boot'],
};

test('schtasks: argument building', () => {
  assert.equal(TASK_NAME, 'Mark42\\mk42d');
  assert.equal(LEGACY_TASK_NAME, 'Mark42\\m42d');
  assert.deepEqual(buildQueryArgs(), ['/Query', '/TN', 'Mark42\\mk42d', '/XML']);
  assert.deepEqual(buildCreateArgs('C:\\t\\x.xml'), ['/Create', '/TN', 'Mark42\\mk42d', '/XML', 'C:\\t\\x.xml', '/F']);
  assert.deepEqual(buildDeleteArgs(), ['/Delete', '/TN', 'Mark42\\mk42d', '/F']);
  assert.deepEqual(buildDeleteArgs(LEGACY_TASK_NAME), ['/Delete', '/TN', 'Mark42\\m42d', '/F']);
});

test('schtasks: task XML — ONLOGON for the current user, node <entry> --boot', () => {
  const xml = buildTaskXml(ACTION, 'DESKTOP-1\\ester');
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DESKTOP-1\\ester<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node.exe<\/Command>/);
  // 따옴표는 XML 텍스트에서 &quot; 로 이스케이프돼요 (작업 스케줄러가 풀어서 "…" 로 넘겨요)
  assert.match(xml, /<Arguments>&quot;C:\\Dev\\work area\\Mark42\\mark42\\daemon\\dist\\mk42d.mjs&quot; --boot<\/Arguments>/);
  assert.match(xml, /<URI>\\Mark42\\mk42d<\/URI>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.ok(!buildTaskXml({ command: 'a&b', args: [] }, 'u').includes('a&b'), 'xml escaped');
});

test('schtasks: argument quoting', () => {
  assert.equal(quoteArg('--boot'), '--boot');
  assert.equal(quoteArg('C:\\a b\\c'), '"C:\\a b\\c"');
  assert.equal(quoteArg('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteArg(''), '""');
});

test('schtasks: /Query result parsing', () => {
  const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
  assert.deepEqual(parseQueryResult({ code: 1, stdout: '', stderr: 'ERROR: not found' }), { exists: false, enabled: false });
  assert.deepEqual(parseQueryResult(ok(buildTaskXml(ACTION, 'u'))), { exists: true, enabled: true });
  const disabled = buildTaskXml(ACTION, 'u').replace(
    /<Settings>([\s\S]*?)<Enabled>true<\/Enabled>/,
    '<Settings>$1<Enabled>false</Enabled>',
  );
  assert.deepEqual(parseQueryResult(ok(disabled)), { exists: true, enabled: false });
});

test('currentUserId uses USERDOMAIN\\USERNAME', () => {
  assert.equal(currentUserId({ USERDOMAIN: 'PC', USERNAME: 'me' }), 'PC\\me');
  assert.equal(currentUserId({ USERNAME: 'me' }), 'me');
});

/** 이름별로 등록 상태를 기억하는 가짜 schtasks — 실제 schtasks는 절대 실행하지 않아요. */
function fakeSchtasks(
  registered: Set<string>,
  calls: { command: string; args: string[]; xml?: string }[] = [],
  disabled = new Set<string>(),
  actions = new Map<string, TaskAction>(),
) {
  return async (command: string, args: string[]): Promise<CommandResult> => {
    const call: { command: string; args: string[]; xml?: string } = { command, args };
    calls.push(call);
    const name = args[2]!;
    if (args[0] === '/Create') {
      const file = args[4]!;
      const buf = readFileSync(file);
      assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 LE BOM');
      call.xml = buf.subarray(2).toString('utf16le');
      registered.add(name);
      const created = parseTaskAction(call.xml);
      if (created) actions.set(name, created);
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    }
    if (args[0] === '/Delete') {
      registered.delete(name);
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    }
    if (!registered.has(name)) return { code: 1, stdout: '', stderr: 'ERROR' };
    const xml = buildTaskXml(actions.get(name) ?? ACTION, 'PC\\me');
    return { code: 0, stdout: disabled.has(name) ? xml.replace('<Enabled>true</Enabled>\n  </Settings>', '<Enabled>false</Enabled>\n  </Settings>') : xml, stderr: '' };
  };
}

test('task XML action round trip — Arguments split back the way quoteArg joined them', () => {
  const action: TaskAction = {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\a b\\dist\\m42d.mjs', '--boot', '--home', 'C:\\Users\\me\\AppData\\Local\\Mark42', '--pipe', 'mark42-x', 'tail\\', 'say "hi"', 'x&y<z', ''],
    workingDirectory: 'C:\\w d',
  };
  assert.deepEqual(parseTaskAction(buildTaskXml(action, 'u')), action);
  assert.deepEqual(splitTaskArguments('a  "b c"\t\\\\server\\x "d\\\\" e\\"f'), ['a', 'b c', '\\\\server\\x', 'd\\', 'e"f']);
  assert.equal(parseTaskAction('<Task></Task>'), undefined);
});

test('Autostart (D41): a task left under the old name is shown, then moved from its own action', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const registered = new Set([LEGACY_TASK_NAME]);
    const calls: { command: string; args: string[]; xml?: string }[] = [];
    const legacyAction: TaskAction = {
      command: 'C:\\node\\node.exe',
      args: ['C:\\src\\daemon\\dist\\m42d.mjs', '--boot', '--home', 'C:\\h', '--pipe', 'p1'],
    };
    const actions = new Map([[LEGACY_TASK_NAME, legacyAction]]);
    const a = new Autostart({ run: fakeSchtasks(registered, calls, new Set(), actions), action: ACTION, userId: 'PC\\me', tmpDir: dir });
    assert.deepEqual(await a.get(), { enabled: true, method: 'taskScheduler', taskName: LEGACY_TASK_NAME });

    // plan이 거절하면(이 데몬의 작업이 아님) 아무것도 바꾸지 않아요
    let seen: TaskAction | undefined;
    assert.deepEqual(await a.migrateLegacy((l) => ((seen = l), undefined)), { outcome: 'skipped', legacy: legacyAction });
    assert.deepEqual(seen, legacyAction, 'plan sees the legacy task action, not this process');
    assert.deepEqual([...registered], [LEGACY_TASK_NAME]);
    assert.ok(!calls.some((c) => c.args[0] === '/Create' || c.args[0] === '/Delete'));

    const moved = { ...legacyAction, args: ['C:\\src\\daemon\\dist\\mk42d.mjs', ...legacyAction.args.slice(1)] };
    assert.deepEqual(await a.migrateLegacy(() => moved), { outcome: 'migrated', action: moved });
    assert.deepEqual([...registered], [TASK_NAME]);
    const created = calls.find((c) => c.args[0] === '/Create')!.xml!;
    assert.deepEqual(parseTaskAction(created), moved, 'new task keeps the legacy command, home and pipe');
    assert.deepEqual(await a.get(), { enabled: true, method: 'taskScheduler', taskName: TASK_NAME });
    assert.deepEqual(await a.migrateLegacy(() => moved), { outcome: 'none' }, 'nothing left to move');

    // 켜기도 옛 작업을 지우고, 끄기는 둘 다 지워요
    registered.add(LEGACY_TASK_NAME);
    await a.set(true);
    assert.deepEqual([...registered], [TASK_NAME]);
    registered.add(LEGACY_TASK_NAME);
    assert.deepEqual(await a.set(false), { enabled: false, method: 'taskScheduler', taskName: TASK_NAME });
    assert.equal(registered.size, 0);

    // 꺼 둔 옛 작업은 옮기지 않아요(get은 꺼진 상태로 보여 줘요)
    const off = new Set([LEGACY_TASK_NAME]);
    const b = new Autostart({ run: fakeSchtasks(off, [], new Set([LEGACY_TASK_NAME])), action: ACTION, userId: 'PC\\me', tmpDir: dir });
    assert.deepEqual(await b.get(), { enabled: false, method: 'taskScheduler', taskName: LEGACY_TASK_NAME });
    assert.deepEqual(await b.migrateLegacy(() => ACTION), { outcome: 'none' });
    assert.deepEqual([...off], [LEGACY_TASK_NAME]);
  } finally {
    cleanup();
  }
});

test('Autostart get/set via injected runner (schtasks never executed)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const calls: { command: string; args: string[]; xml?: string }[] = [];
    const run = fakeSchtasks(new Set(), calls);
    const a = new Autostart({ run, action: ACTION, userId: 'PC\\me', tmpDir: dir, schtasks: 'schtasks.exe' });
    assert.deepEqual(await a.get(), { enabled: false, method: 'taskScheduler', taskName: TASK_NAME });
    assert.equal((await a.set(true)).enabled, true);
    const create = calls.find((c) => c.args[0] === '/Create')!;
    assert.equal(create.command, 'schtasks.exe');
    assert.match(create.xml!, /<UserId>PC\\me<\/UserId>/);
    assert.equal(readdirSync(dir).length, 0, 'temp XML removed');
    assert.ok(!existsSync(create.args[4]!));
    assert.equal((await a.set(false)).enabled, false);
    assert.ok(calls.some((c) => c.args[0] === '/Delete'));

    const failing = new Autostart({
      run: async () => ({ code: 5, stdout: '', stderr: 'Access is denied.' }),
      action: ACTION,
      userId: 'u',
      tmpDir: dir,
    });
    await assert.rejects(failing.set(true), /Access is denied/);
  } finally {
    cleanup();
  }
});
