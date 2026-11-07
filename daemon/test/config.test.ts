import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultPipeName } from '@mark42/protocol/paths';
import {
  ArgError,
  autostartEntryArgs,
  bootRespawnPlan,
  DETACHED_ENV,
  legacyTaskMigration,
  parseArgs,
  pipeNameForWindows,
} from '../src/config.ts';
import { createFileLogger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

test('args: defaults derive pipe from home', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const a = parseArgs([], env);
  assert.equal(a.hubServer, true);
  assert.equal(a.boot, false);
  assert.equal(a.logLevel, 'info');
  assert.equal(a.pipe, defaultPipeName({ ...env, MARK42_HOME: a.home }));
  const b = parseArgs(['--home', 'D:\\m42', '--log-level=debug', '--no-hub-server', '--boot', '--open-hub'], env);
  assert.equal(b.home, 'D:\\m42');
  assert.equal(b.logLevel, 'debug');
  assert.equal(b.hubServer, false);
  assert.equal(b.boot, true);
  assert.equal(b.openHub, true);
  assert.equal(b.pipe, defaultPipeName({ ...env, MARK42_HOME: 'D:\\m42' }));
  assert.notEqual(a.pipe, b.pipe);
  assert.equal(parseArgs(['--pipe', '\\\\.\\pipe\\x'], env).pipe, '\\\\.\\pipe\\x');
  assert.equal(parseArgs([], { ...env, MARK42_PIPE: '\\\\.\\pipe\\env' }).pipe, '\\\\.\\pipe\\env');
});

test('args: errors', () => {
  assert.throws(() => parseArgs(['--bogus']), ArgError);
  assert.throws(() => parseArgs(['--home']), ArgError);
  assert.throws(() => parseArgs(['--log-level', 'loud']), ArgError);
});

test('log: writes lines and rotates by size', () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = join(dir, 'logs', 'mk42d.log');
    const log = createFileLogger({ file, maxBytes: 200, keep: 2, level: 'info' });
    log.debug('hidden');
    for (let i = 0; i < 10; i++) log.child('core').info(`line ${i} ${'x'.repeat(30)}`);
    const cur = readFileSync(file, 'utf8');
    assert.ok(!cur.includes('hidden'));
    assert.match(cur, /INFO  \[core\] line 9/);
    assert.ok(readFileSync(join(dir, 'logs', 'mk42d.1.log'), 'utf8').length > 0);
  } finally {
    cleanup();
  }
});

test('autostart args carry the effective home and pipe (env-only values are not inherited by the task)', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', MARK42_HOME: 'D:\\m42', MARK42_PIPE: '\\\\.\\pipe\\custom' };
  const a = parseArgs([], env);
  const argv = autostartEntryArgs('C:\\src\\daemon\\main.ts', a);
  assert.deepEqual(argv, ['C:\\src\\daemon\\main.ts', '--boot', '--home', 'D:\\m42', '--pipe', '\\\\.\\pipe\\custom']);
  // 작업이 MARK42_* 없이 이 인자로 돌면 같은 home·pipe가 나와요
  const back = parseArgs(argv.slice(1), { LOCALAPPDATA: env.LOCALAPPDATA });
  assert.equal(back.home, a.home);
  assert.equal(back.pipe, a.pipe);
  assert.equal(back.boot, true);
});

test('D41 legacy task migration: only the task of this home/pipe, keeping its own action', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const mine = parseArgs([], env); // 사용자 기본 데몬
  const legacy = {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\src\\daemon\\dist\\m42d.mjs', '--boot', '--home', mine.home, '--pipe', mine.pipe],
    workingDirectory: 'C:\\src',
  };
  const all = () => true;
  const moved = legacyTaskMigration(legacy, mine, { exists: all, env });
  assert.deepEqual(moved, { ...legacy, args: ['C:\\src\\daemon\\dist\\mk42d.mjs', ...legacy.args.slice(1)] });
  // 대소문자·끝 구분자가 달라도 같은 home이에요
  assert.ok(legacyTaskMigration(legacy, { home: mine.home.toUpperCase() + '\\', pipe: mine.pipe.toUpperCase() }, { exists: all, env }));
  // 새 번들이 옆에 없으면 진입 파일은 그대로(빌드가 만든 m42d.mjs shim이 새 코드를 불러요)
  assert.deepEqual(legacyTaskMigration(legacy, mine, { exists: () => false, env }), legacy);
  // 개발 진입점(main.ts)으로 등록한 작업은 진입 파일을 바꾸지 않아요
  const dev = { ...legacy, args: ['C:\\src\\daemon\\src\\main.ts', ...legacy.args.slice(1)] };
  assert.deepEqual(legacyTaskMigration(dev, mine, { exists: all, env }), dev);
  // --home·--pipe가 없는 작업은 기본값으로 비교해요
  assert.ok(legacyTaskMigration({ ...legacy, args: [legacy.args[0]!, '--boot'] }, mine, { exists: all, env }));

  // 시험·개발용 데몬(다른 home 또는 pipe)은 사용자 작업을 옮기지 않아요
  const test1 = parseArgs(['--home', 'C:\\temp\\x', '--pipe', '\\\\.\\pipe\\m42-test'], env);
  assert.equal(legacyTaskMigration(legacy, test1, { exists: all, env }), undefined);
  assert.equal(legacyTaskMigration(legacy, { home: mine.home, pipe: '\\\\.\\pipe\\other' }, { exists: all, env }), undefined);
  // 모르는 인자·빈 인자면 손대지 않아요
  assert.equal(legacyTaskMigration({ ...legacy, args: [...legacy.args, '--future-flag'] }, mine, { exists: all, env }), undefined);
  assert.equal(legacyTaskMigration({ ...legacy, args: [] }, mine, { exists: all, env }), undefined);
});

test('build writes the D41 m42d.mjs shim that loads mk42d.mjs', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { scripts: { build: string } };
  assert.match(pkg.scripts.build, /--outfile=dist\/mk42d\.mjs .*&& node scripts\/write-legacy-shim\.mjs( &&|$)/);
  const script = readFileSync(join(import.meta.dirname, '..', 'scripts', 'write-legacy-shim.mjs'), 'utf8');
  assert.match(script, /'m42d\.mjs'/);
  assert.match(script, /import '\.\/mk42d\.mjs';/);
});

test('boot respawn: only for --boot on Windows, once', () => {
  const argv = ['C:\\node.exe', 'C:\\src\\main.ts', '--boot', '--home', 'D:\\m'];
  const plan = bootRespawnPlan({ boot: true }, 'C:\\node.exe', ['--no-warnings'], argv, { PATH: 'x' }, 'win32');
  assert.deepEqual(plan, {
    command: 'C:\\node.exe',
    args: ['--no-warnings', 'C:\\src\\main.ts', '--boot', '--home', 'D:\\m'],
    env: { PATH: 'x', [DETACHED_ENV]: '1' },
  });
  assert.equal(bootRespawnPlan({ boot: true }, 'n', [], argv, { [DETACHED_ENV]: '1' }, 'win32'), undefined);
  assert.equal(bootRespawnPlan({ boot: false }, 'n', [], argv, {}, 'win32'), undefined);
  assert.equal(bootRespawnPlan({ boot: true }, 'n', [], argv, {}, 'linux'), undefined);
});

test('args: pipe name is handed to windows only when it differs from the plain default', () => {
  const env = { LOCALAPPDATA: 'C:/Users/u/AppData/Local' };
  assert.equal(pipeNameForWindows(defaultPipeName(env), env), undefined);
  assert.equal(pipeNameForWindows(parseArgs([], env).pipe, env), undefined);
  const custom = parseArgs(['--home', 'D:/tmp/m42'], env);
  assert.equal(pipeNameForWindows(custom.pipe, env), custom.pipe);
  const viaEnv = { ...env, MARK42_PIPE: 'mark42-test-pipe' };
  assert.equal(pipeNameForWindows(parseArgs([], viaEnv).pipe, viaEnv), 'mark42-test-pipe');
});
