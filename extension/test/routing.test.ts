import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTabRouting, RecentSet, type RouteContext } from '../src/lib/routing.ts';

const agent: RouteContext = { role: 'agent-claude', connected: true, folderPath: 'C:\\Dev\\proj', virtualDocPlacement: 'agentWindow' };
const fileTab = { kind: 'text' as const, scheme: 'file', uri: 'file:///c%3A/Dev/proj/a.ts' };

test('file text tab in agent window is routed', () => {
  assert.deepEqual(decideTabRouting(fileTab, agent), { action: 'route', kind: 'file', uri: fileTab.uri });
  assert.equal(decideTabRouting({ kind: 'notebook', scheme: 'file', uri: 'file:///x.ipynb' }, agent).action, 'route');
  assert.equal(
    decideTabRouting({ kind: 'custom', viewType: 'imagePreview.previewEditor', scheme: 'file', uri: 'file:///x.png' }, agent).action,
    'route',
  );
});

test('non-agent and unmanaged windows keep everything', () => {
  assert.deepEqual(decideTabRouting(fileTab, { ...agent, role: 'editor' }), { action: 'keep', reason: 'not-agent-window' });
  assert.deepEqual(decideTabRouting(fileTab, { ...agent, role: 'hub' }), { action: 'keep', reason: 'not-agent-window' });
  assert.deepEqual(decideTabRouting(fileTab, { ...agent, role: undefined }), { action: 'keep', reason: 'unmanaged' });
});

test('virtual docs stay (D15 ③) unless auxWindow placement', () => {
  const diff = { kind: 'diff' as const, originalScheme: 'file', modifiedScheme: '_claude_vscode_fs_right' };
  assert.deepEqual(decideTabRouting(diff, agent), { action: 'keep', reason: 'virtual' });
  assert.deepEqual(decideTabRouting({ kind: 'text', scheme: 'untitled', uri: 'untitled:1' }, agent), { action: 'keep', reason: 'virtual' });
  assert.deepEqual(decideTabRouting(diff, { ...agent, virtualDocPlacement: 'auxWindow' }), { action: 'aux', reason: 'virtual' });
});

test('agent surfaces and webviews are never routed', () => {
  assert.equal(decideTabRouting({ kind: 'webview', viewType: 'mainThreadWebview-claudeVSCodePanel' }, agent).action, 'keep');
  assert.deepEqual(
    decideTabRouting({ kind: 'custom', viewType: 'chatgpt.conversationEditor', scheme: 'openai-codex', uri: 'openai-codex://route/local/x' }, agent),
    { action: 'keep', reason: 'agent-surface' },
  );
  assert.deepEqual(decideTabRouting({ kind: 'webview', viewType: 'markdown.preview' }, agent), { action: 'keep', reason: 'webview' });
  assert.deepEqual(decideTabRouting({ kind: 'other' }, agent), { action: 'keep', reason: 'unsupported' });
});

test('offline or folderless agent window does not close tabs', () => {
  assert.deepEqual(decideTabRouting(fileTab, { ...agent, connected: false }), { action: 'keep', reason: 'offline' });
  assert.deepEqual(decideTabRouting(fileTab, { ...agent, folderPath: undefined }), { action: 'keep', reason: 'no-folder' });
});

test('RecentSet suppresses repeats within ttl', () => {
  const r = new RecentSet(1000);
  assert.equal(r.add('a', 0), true);
  assert.equal(r.add('a', 500), false);
  assert.equal(r.add('a', 1600), true);
});
