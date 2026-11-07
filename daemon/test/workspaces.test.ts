import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { folderIdFor, normalizePath } from '@mark42/protocol/paths';
import {
  AGENT_HOST_OFF_SETTINGS,
  ensureRoleWorkspace,
  managedSettings,
  mergeWorkspace,
  MK42_COLORS,
  parseJsonc,
  roleWindowTitle,
  roleWorkspacePath,
} from '../src/workspaces.ts';
import { tempDir } from './helpers.ts';

const FOLDER = process.platform === 'win32' ? 'c:\\Dev\\proj\\' : '/tmp/proj/';

test('workspaces: file path per role and slot', () => {
  const home = process.platform === 'win32' ? 'C:\\M42' : '/m42';
  const id = folderIdFor(FOLDER);
  assert.equal(roleWorkspacePath({ home, role: 'editor', folderPath: FOLDER }), join(home, 'roles', id, 'editor.code-workspace'));
  assert.equal(
    roleWorkspacePath({ home, role: 'agent-claude', folderPath: FOLDER, slotId: 'ab12' }),
    join(home, 'roles', id, 'agent-claude.ab12.code-workspace'),
  );
  assert.equal(roleWorkspacePath({ home, role: 'hub' }), join(home, 'roles', '_hub', 'hub.code-workspace'));
  assert.throws(() => roleWorkspacePath({ home, role: 'agent-codex', folderPath: FOLDER }), /slotId/);
  assert.throws(() => roleWorkspacePath({ home, role: 'agent-codex', folderPath: FOLDER, slotId: '../x' }), /slotId/);
  assert.throws(() => roleWorkspacePath({ home, role: 'editor' }), /folderPath/);
});

test('workspaces: managed settings per role', () => {
  const claude = managedSettings({ role: 'agent-claude', folderPath: FOLDER, slotId: 's1' });
  assert.equal(claude['mark42.role'], 'agent-claude');
  assert.equal(claude['mark42.slotId'], 's1');
  assert.equal(claude['mark42.folderPath'], normalizePath(FOLDER));
  assert.equal(claude['window.autoDetectColorScheme'], false);
  assert.equal(claude['workbench.secondarySideBar.defaultVisibility'], 'maximizedInWorkspace');
  assert.equal(claude['extensions.autoRestart'], false);
  assert.equal(claude['claudeCode.preferredLocation'], 'sidebar');
  assert.equal(claude['workbench.secondarySideBar.forceMaximized'], true, 'the agent panel comes back when the editors close');
  assert.equal(claude['workbench.activityBar.location'], 'hidden', 'no activity bar icons that un-maximize the agent panel');
  assert.equal(claude['workbench.view.alwaysShowHeaderActions'], true, 'Mark42 buttons stay visible with two views in the side bar');
  for (const [k, v] of Object.entries(AGENT_HOST_OFF_SETTINGS)) assert.deepEqual(claude[k], v);
  assert.equal(claude['chat.agentHost.claudeAgent.enabled'], false);

  const codex = managedSettings({ role: 'agent-codex', folderPath: FOLDER, slotId: 's2' });
  assert.equal(codex['claudeCode.preferredLocation'], undefined);
  assert.equal(codex['workbench.secondarySideBar.defaultVisibility'], 'maximizedInWorkspace');

  const editor = managedSettings({ role: 'editor', folderPath: FOLDER });
  assert.equal(editor['workbench.secondarySideBar.defaultVisibility'], 'hidden');
  assert.equal(editor['mark42.slotId'], undefined);
  assert.equal(editor['workbench.secondarySideBar.forceMaximized'], undefined);
  assert.equal(editor['workbench.view.alwaysShowHeaderActions'], undefined);
  assert.equal(editor['workbench.activityBar.location'], undefined);
});

test('workspaces: merge keeps user keys (theme) and rewrites only managed keys', () => {
  const existing = {
    folders: [{ path: 'D:\\old' }],
    settings: {
      'workbench.colorTheme': 'Solarized Dark',
      'workbench.secondarySideBar.defaultVisibility': 'visible',
      'claudeCode.preferredLocation': 'panel',
      'chat.agentsHandoffTip.mode': 'hidden',
    },
    extensions: { recommendations: ['x.y'] },
  };
  const merged = mergeWorkspace(existing, { role: 'agent-codex', folderPath: FOLDER, slotId: 's9' });
  assert.deepEqual(merged.folders, [{ path: normalizePath(FOLDER) }]);
  assert.equal(merged.settings['workbench.colorTheme'], 'Solarized Dark');
  assert.equal(merged.settings['workbench.secondarySideBar.defaultVisibility'], 'maximizedInWorkspace');
  assert.ok(!('claudeCode.preferredLocation' in merged.settings));
  assert.ok(!('chat.agentsHandoffTip.mode' in merged.settings));
  assert.deepEqual(merged.extensions, { recommendations: ['x.y'] });
});

test('workspaces: Mk42 title prefix per role and Mk42 colors merged into the user’s color customizations', () => {
  assert.equal(roleWindowTitle('agent-claude'), '[Mk42 Claude${mark42Session}] ${dirty}${activeEditorShort}${separator}${rootName}');
  assert.equal(roleWindowTitle('agent-codex'), '[Mk42 Codex${mark42Session}] ${dirty}${activeEditorShort}${separator}${rootName}');
  assert.equal(roleWindowTitle('editor'), '[Mk42 편집] ${dirty}${activeEditorShort}${separator}${rootName}', 'session name only in agent windows');
  assert.equal(managedSettings({ role: 'hub' })['window.title'], roleWindowTitle('hub'));
  assert.ok(!roleWindowTitle('editor').includes('${appName}'), 'no «Visual Studio Code» in our titles');

  const merged = mergeWorkspace(
    {
      settings: {
        'window.title': 'mine',
        'workbench.colorCustomizations': { 'editor.background': '#000000', 'titleBar.activeBackground': '#ffffff' },
      },
    },
    { role: 'editor', folderPath: FOLDER },
  );
  assert.equal(merged.settings['window.title'], roleWindowTitle('editor'));
  assert.deepEqual(merged.settings['workbench.colorCustomizations'], { 'editor.background': '#000000', ...MK42_COLORS });
  const fresh = mergeWorkspace(undefined, { role: 'hub' });
  assert.deepEqual(fresh.settings['workbench.colorCustomizations'], MK42_COLORS);
  const broken = mergeWorkspace({ settings: { 'workbench.colorCustomizations': 'oops' } }, { role: 'hub' });
  assert.deepEqual(broken.settings['workbench.colorCustomizations'], MK42_COLORS);
});

test('workspaces: JSONC parser handles comments, trailing commas, strings with slashes', () => {
  const v = parseJsonc(
    '\uFEFF{\n // comment\n "a": "http://x//y", /* block */ "b": [1,2,],\n "c": "q\\"//",\n}',
  ) as Record<string, unknown>;
  assert.deepEqual(v, { a: 'http://x//y', b: [1, 2], c: 'q"//' });
});

test('workspaces: ensure creates, merges and skips no-op rewrites', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const spec = { home, role: 'agent-claude' as const, folderPath: FOLDER, slotId: 's1' };
    const r1 = await ensureRoleWorkspace(spec);
    assert.equal(r1.created, true);
    const first = JSON.parse(readFileSync(r1.file, 'utf8'));
    assert.equal(first.settings['mark42.slotId'], 's1');

    // VS Code가 테마를 워크스페이스 파일에 저장한 상황 (탭 들여쓰기 + 주석)
    const text = readFileSync(r1.file, 'utf8').replace('"settings": {', '"settings": {\n\t\t// user\n\t\t"workbench.colorTheme": "Red",');
    writeFileSync(r1.file, text);
    const r2 = await ensureRoleWorkspace(spec);
    assert.equal(r2.changed, false, 'semantically identical → no rewrite');

    const before = statSync(r1.file).mtimeMs;
    const r3 = await ensureRoleWorkspace({ ...spec });
    assert.equal(r3.changed, false);
    assert.equal(statSync(r1.file).mtimeMs, before);

    // 관리 키가 바뀌면 다시 쓰되 테마는 보존
    const cur = JSON.parse(JSON.stringify(parseJsonc(readFileSync(r1.file, 'utf8'))));
    cur.settings['window.autoDetectColorScheme'] = true;
    writeFileSync(r1.file, JSON.stringify(cur));
    const r4 = await ensureRoleWorkspace(spec);
    assert.equal(r4.changed, true);
    const after = JSON.parse(readFileSync(r1.file, 'utf8'));
    assert.equal(after.settings['window.autoDetectColorScheme'], false);
    assert.equal(after.settings['workbench.colorTheme'], 'Red');
  } finally {
    cleanup();
  }
});

test('workspaces: corrupt workspace file is backed up and regenerated', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const spec = { home, role: 'editor' as const, folderPath: FOLDER };
    const file = roleWorkspacePath(spec);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ broken');
    const r = await ensureRoleWorkspace(spec);
    assert.equal(r.created, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).settings['mark42.role'], 'editor');
  } finally {
    cleanup();
  }
});

test('workspaces: non-default pipe name is written for windows and removed again', () => {
  const withPipe = mergeWorkspace(undefined, { role: 'editor', folderPath: FOLDER, pipeName: 'mark42-test-pipe' });
  assert.equal(withPipe.settings['mark42.pipeName'], 'mark42-test-pipe');
  const back = mergeWorkspace(withPipe, { role: 'editor', folderPath: FOLDER });
  assert.equal('mark42.pipeName' in back.settings, false);
});
