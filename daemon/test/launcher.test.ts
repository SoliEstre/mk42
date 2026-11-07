import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyRegistry, type DaemonSettings } from '../src/registry.ts';
import {
  AppLauncher,
  AGENT_WINDOW_TRIMMED_BUILTINS,
  buildLaunchArgs,
  disabledExtensionsFor,
  discoverInstalls,
  sanitizeLaunchEnv,
  selectInstall,
  type DiscoveredInstall,
} from '../src/launcher.ts';
import { tempDir, type SpawnCall } from './helpers.ts';

test('launcher: args order and flags', () => {
  assert.deepEqual(
    buildLaunchArgs({
      workspaceFile: 'C:\\h\\w.code-workspace',
      userDataDir: 'C:\\ud',
      extensionsDir: 'C:\\ex',
      profile: 'Agent-Claude',
      disableExtensions: ['openai.chatgpt'],
    }),
    [
      '--user-data-dir',
      'C:\\ud',
      '--extensions-dir',
      'C:\\ex',
      '--profile',
      'Agent-Claude',
      '--disable-extension',
      'openai.chatgpt',
      'C:\\h\\w.code-workspace',
    ],
  );
  assert.deepEqual(buildLaunchArgs({ workspaceFile: 'w' }), ['w']);
});

test('launcher: env sanitizing drops VSCODE_* and ELECTRON_*', () => {
  const env = sanitizeLaunchEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', VSCODE_IPC_HOOK: 'x', vscode_pid: '2' });
  assert.deepEqual(env, { PATH: 'p' });
});

test('launcher: extensionDevelopmentPath goes on fresh launches only, through a per-window link', async () => {
  const { dir: home, cleanup } = tempDir();
  try {
    const extDir = join(home, 'src', 'extension');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'package.json'), '{}');
    const settings: DaemonSettings = { ...emptyRegistry().settings, extensionDevelopmentPath: extDir };
    const calls: SpawnCall[] = [];
    const launcher = new AppLauncher({ defaultAppProduct: 'vscode',
      home,
      getSettings: () => settings,
      discover: async () => [{ version: '1.142.0', exe: 'C:\\B\\Code.exe', source: 'registry' }],
      spawn: async (command, args) => {
        calls.push({ command, args });
        return { pid: 1 };
      },
      env: { PATH: 'x' },
    });
    const devArg = (args: string[]) => args.find((a) => a.startsWith('--extensionDevelopmentPath='))?.slice('--extensionDevelopmentPath='.length);
    const hub = await launcher.launch({ workspaceFile: 'C:\\roles\\_hub\\hub.code-workspace', role: 'hub' });
    const agent = await launcher.launch({ workspaceFile: 'C:\\roles\\f1\\agent-claude.s1.code-workspace', role: 'agent-claude' });
    const hubAgain = await launcher.launch({ workspaceFile: 'c:\\ROLES\\_hub\\hub.code-workspace', role: 'hub' });
    const p1 = devArg(hub.args)!;
    const p2 = devArg(agent.args)!;
    // VS Code는 개발 경로가 같은 창을 다시 로드해요 — 창마다 달라야 해요
    assert.notEqual(p1, p2);
    assert.equal(devArg(hubAgain.args), p1, 'same workspace file → same link');
    assert.ok(p1.startsWith(join(home, 'devext')));
    assert.ok(existsSync(join(p1, 'package.json')), 'link resolves to the extension folder');
    assert.ok(existsSync(join(p2, 'package.json')));
    assert.equal(hub.args.at(-1), 'C:\\roles\\_hub\\hub.code-workspace');

    // 설정이 다른 폴더로 바뀌면 링크를 다시 만들어요
    const ext2 = join(home, 'src2');
    mkdirSync(ext2);
    writeFileSync(join(ext2, 'marker.txt'), '');
    settings.extensionDevelopmentPath = ext2;
    const moved = await launcher.launch({ workspaceFile: 'C:\\roles\\_hub\\hub.code-workspace', role: 'hub' });
    assert.equal(devArg(moved.args), p1);
    assert.ok(existsSync(join(p1, 'marker.txt')));

    const focus = await launcher.launch({ workspaceFile: 'C:\\roles\\_hub\\hub.code-workspace', role: 'hub', appVersion: '1.142.0', exactVersion: true });
    assert.ok(!focus.args.some((a) => a.startsWith('--extensionDevelopmentPath')));
    assert.equal(calls.length, 5);
  } finally {
    cleanup();
  }
});

test('launcher: role-based disabled extensions — other agent always, unused built-ins in agent windows only when trimming is on (D47)', () => {
  assert.deepEqual(disabledExtensionsFor('agent-claude', {}), ['openai.chatgpt']);
  assert.deepEqual(disabledExtensionsFor('editor', {}), ['anthropic.claude-code', 'openai.chatgpt']);
  assert.deepEqual(disabledExtensionsFor('agent-codex', { trimAgentWindowBuiltins: true }), ['anthropic.claude-code', ...AGENT_WINDOW_TRIMMED_BUILTINS]);
  assert.deepEqual(disabledExtensionsFor('editor', { trimAgentWindowBuiltins: true }), ['anthropic.claude-code', 'openai.chatgpt'], 'editor windows keep git');
  assert.deepEqual(disabledExtensionsFor('agent-claude', { disableOtherAgentExtension: false, trimAgentWindowBuiltins: true }), [...AGENT_WINDOW_TRIMMED_BUILTINS]);
  assert.ok(!AGENT_WINDOW_TRIMMED_BUILTINS.includes('vscode.git-base'));
  // language servers go, grammars (syntax colouring) stay
  for (const id of ['vscode.json-language-features', 'vscode.typescript-language-features', 'vscode.markdown-language-features']) assert.ok(AGENT_WINDOW_TRIMMED_BUILTINS.includes(id), id);
  for (const id of ['vscode.json', 'vscode.typescript', 'vscode.markdown', 'vscode.markdown-basics']) assert.ok(!AGENT_WINDOW_TRIMMED_BUILTINS.includes(id), id);
});
