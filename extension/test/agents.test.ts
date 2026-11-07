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
const { ClaudeAdapter, CodexAdapter } = (await import('../src/agents.ts')) as typeof import('../src/agents.ts');

const silent = { info() {}, warn() {}, error() {}, debug() {}, show() {} };
const SID = '0b6c4f7e-1111-2222-3333-444455556666';

function withClaude(): void {
  vs.reset();
  vs.state.extensions.set('anthropic.claude-code', { id: 'anthropic.claude-code', packageJSON: { version: '2.1.301' }, isActive: true, activate: async () => {} });
}

test('claude: editor.open (sidebar) is sendable', async () => {
  withClaude();
  const r = await new ClaudeAdapter(silent).open(SID, 'go');
  assert.deepEqual(r, { filled: true });
});

test('claude: URI fallback fills an editor tab — not sendable, routed back to this window', async () => {
  withClaude();
  vs.state.commandImpl.set('claude-vscode.editor.open', () => {
    throw new Error('contract changed');
  });
  const r = await new ClaudeAdapter(silent).open(SID, 'go');
  assert.equal(r.sendable, false);
  assert.match(r.detail ?? '', /uri-fallback/);
  assert.equal(vs.state.openedExternal[0], `vscode://anthropic.claude-code/open?session=${SID}&prompt=go&windowId=1`);
});

test('codex: thread URI goes through asExternalUri (windowId) before openExternal', async () => {
  vs.reset();
  vs.state.extensions.set('openai.chatgpt', { id: 'openai.chatgpt', packageJSON: { version: '26.1007.21434' }, isActive: true, activate: async () => {} });
  await new CodexAdapter(silent).open('019a0000-0000-7000-8000-000000000001', undefined);
  assert.deepEqual(vs.state.openedExternal, ['vscode://openai.chatgpt/local/019a0000-0000-7000-8000-000000000001?windowId=1']);
});
