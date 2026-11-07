import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentKind, SessionSummary, WindowInfo } from '@mark42/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(join(here, 'helpers', 'vscode-stub.ts')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true, format: 'module' };
    return next(specifier, context);
  },
});
const stub = (await import(stubUrl)) as typeof import('./helpers/vscode-stub.ts');
const { sessionTitleLabel, titleValue, WindowTitle, TITLE_CONTEXT_KEY, TITLE_VARIABLE } = (await import('../src/windowTitle.ts')) as typeof import('../src/windowTitle.ts');

const log = { debug() {}, info() {}, warn() {}, error() {} } as never;

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { agent: 'claude', id, cwd: 'C:\\p', updatedAt: '2026-11-04T00:00:00Z', ...over };
}

function fakeDaemon(p: { sessions: SessionSummary[]; windows?: WindowInfo[]; windowId?: string; connected?: boolean }) {
  const calls: { method: string; params: unknown }[] = [];
  const api = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'sessions.list') return p.sessions;
      if (method === 'windows.list') return p.windows ?? [];
      throw new Error(`unexpected ${method}`);
    },
  };
  return { daemon: { get api() { return p.connected === false ? undefined : api; }, windowId: p.windowId } as never, calls };
}

const contexts = () => stub.state.executed.filter((e) => e.id === 'setContext').map((e) => e.args);

test('sessionTitleLabel: title first, else the first line of the last prompt, one line, clipped at 60', () => {
  assert.equal(sessionTitleLabel({ title: '  설치 마법사 만들기 ', lastPrompt: 'x' }), '설치 마법사 만들기');
  assert.equal(sessionTitleLabel({ lastPrompt: '\n\n  첫   줄\n둘째 줄' }), '첫 줄');
  assert.equal(sessionTitleLabel({ title: '   ', lastPrompt: 'p' }), 'p');
  assert.equal(sessionTitleLabel(undefined), '');
  const long = '가'.repeat(80);
  const clipped = sessionTitleLabel({ title: long });
  assert.equal([...clipped].length, 60);
  assert.ok(clipped.endsWith('…'));
  assert.equal(titleValue(''), '', 'no name → the old title, character for character');
  assert.equal(titleValue('이름'), ': 이름');
});

test('WindowTitle: registers the title variable once and sets the bound session name; same name is not set again', async () => {
  stub.reset();
  const { daemon, calls } = fakeDaemon({ sessions: [session('a'), session('s1', { title: '창 제목에 세션 이름' })] });
  const t = new WindowTitle({ daemon, log, agent: () => 'claude' as AgentKind, folder: () => 'C:\\p', sessionId: () => 's1' });
  await t.refresh();
  await t.refresh();
  const reg = stub.state.executed.filter((e) => e.id === 'registerWindowTitleVariable');
  assert.deepEqual(reg.map((e) => e.args), [[TITLE_VARIABLE, TITLE_CONTEXT_KEY]]);
  assert.deepEqual(contexts(), [[TITLE_CONTEXT_KEY, ': 창 제목에 세션 이름']], '«[Mk42 Claude: 이름]» inside the bracket');
  assert.deepEqual(calls[0], { method: 'sessions.list', params: { cwd: 'C:\\p', agent: 'claude', includeSubagents: false, limit: 200 } });
  t.dispose();
});

test('WindowTitle: after a reload (no session in the extension) the window’s session comes from the daemon window list', async () => {
  stub.reset();
  const { daemon } = fakeDaemon({
    sessions: [session('s2', { agent: 'codex', title: 'Codex 스레드' })],
    windows: [{ windowId: 'w-other', role: 'agent-codex', sessionId: 'x', pid: 1, appVersion: '1', extensions: [] }, { windowId: 'w1', role: 'agent-codex', sessionId: 's2', pid: 2, appVersion: '1', extensions: [] }],
    windowId: 'w1',
  });
  const t = new WindowTitle({ daemon, log, agent: () => 'codex' as AgentKind, folder: () => 'C:\\p', sessionId: () => undefined });
  await t.refresh();
  assert.equal(t.label, 'Codex 스레드');
  t.dispose();
});

test('WindowTitle: not an agent window → nothing; disconnected → keeps the name; session missing from the list keeps its name', async () => {
  stub.reset();
  const none = new WindowTitle({ daemon: fakeDaemon({ sessions: [] }).daemon, log, agent: () => undefined, folder: () => undefined, sessionId: () => 's' });
  await none.refresh();
  assert.equal(stub.state.executed.length, 0);

  const p = { sessions: [session('s1', { title: '처음 이름' })], connected: true };
  const { daemon } = fakeDaemon(p);
  const t = new WindowTitle({ daemon, log, agent: () => 'claude' as AgentKind, folder: () => 'C:\\p', sessionId: () => 's1' });
  await t.refresh();
  p.connected = false;
  await t.refresh();
  assert.equal(t.label, '처음 이름');
  p.connected = true;
  p.sessions = [];
  await t.refresh();
  assert.equal(t.label, '처음 이름', 'same session, not in this page of the list');
  assert.equal(contexts().length, 1);
  t.dispose();
});
