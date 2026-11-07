import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const { AgentUpdateButton, UPDATE_READY_CONTEXT, UPDATE_UNVERIFIED_CONTEXT, AGENT_WINDOW_CONTEXT, RESTART_UPDATED_COMMAND, SET_TITLE_LABEL_COMMAND, AGENT_RELOAD_COMMAND } = (await import(
  '../src/agentUpdate.ts'
)) as typeof import('../src/agentUpdate.ts');

const silent = { info() {}, warn() {}, error() {}, debug() {}, show() {} };
const ID = 'anthropic.claude-code';

function setup(): { dir: string; done: () => void } {
  vs.reset();
  const dir = mkdtempSync(join(tmpdir(), 'mk42-upd-'));
  const running = join(dir, `${ID}-2.1.312-win32-x64`);
  mkdirSync(running);
  vs.state.extensions.set(ID, { id: ID, extensionPath: running, packageJSON: { version: '2.1.312' }, isActive: true, activate: async () => {} } as never);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function install(dir: string, version: string, complete = true): void {
  const folder = join(dir, `${ID}-${version}-win32-x64`);
  mkdirSync(folder, { recursive: true });
  if (complete) writeFileSync(join(folder, 'package.json'), '{}');
}
const flags = (key: string) => vs.state.executed.filter((e) => e.id === 'setContext' && e.args[0] === key).map((e) => e.args[1]);
const ran = (id: string) => vs.state.executed.some((e) => e.id === id);

test('agent update: a newer, fully installed folder turns the button into «apply»; older, half-written or obsolete ones do not', async () => {
  const { dir, done } = setup();
  const b = new AgentUpdateButton(() => 'agent-claude', () => undefined, silent);
  try {
    assert.equal(await b.refresh(), undefined);
    assert.equal(flags(AGENT_WINDOW_CONTEXT).at(-1), true);
    install(dir, '2.1.9');
    assert.equal(await b.refresh(), undefined, 'older is not an update');
    install(dir, '2.1.314', false);
    assert.equal(await b.refresh(), undefined, 'still being written');
    install(dir, '2.1.314');
    assert.equal(await b.refresh(), '2.1.314');
    writeFileSync(join(dir, '.obsolete'), JSON.stringify({ [`${ID}-2.1.314-win32-x64`]: true }));
    assert.equal(await b.refresh(), undefined, 'one being removed is not an update');
    assert.deepEqual(flags(UPDATE_READY_CONTEXT).slice(-2), [true, false]);
  } finally {
    b.dispose();
    done();
  }
});

test('agent update: non-agent windows hide the button', async () => {
  const { done } = setup();
  const b = new AgentUpdateButton(() => 'editor', () => undefined, silent);
  try {
    await b.refresh();
    assert.equal(flags(AGENT_WINDOW_CONTEXT).at(-1), false);
  } finally {
    b.dispose();
    done();
  }
});

test('agent update: check asks the daemon for this agent only, then applies with consent via the Mk42 restart command', async () => {
  const { dir, done } = setup();
  const requests: unknown[] = [];
  const api = {
    request: async (method: string, params: unknown) => {
      requests.push([method, params]);
      if (method === 'extensions.status') return { updates: [] };
      install(dir, '2.1.314'); // the daemon installed it
      return { updates: [{ id: ID, installed: '2.1.314', latest: '2.1.314', status: 'updated', verification: 'verified' }] };
    },
  };
  const b = new AgentUpdateButton(() => 'agent-claude', () => api as never, silent);
  try {
    await b.check(); // declined
    assert.deepEqual(
      requests.filter((r) => (r as unknown[])[0] !== 'extensions.status'),
      [['extensions.checkUpdates', { ids: [ID] }]],
    );
    assert.ok(vs.state.messages.some((m) => m.text === '업데이트를 적용할까요?'));
    assert.ok(!ran(RESTART_UPDATED_COMMAND) && !ran('workbench.action.reloadWindow'), 'declined: nothing restarts');

    vs.state.commandImpl.set(RESTART_UPDATED_COMMAND, () => 1);
    vs.state.answers.push('업데이트 적용');
    await b.apply();
    assert.ok(ran(RESTART_UPDATED_COMMAND));
    assert.ok(!ran('workbench.action.reloadWindow'), 'restarted with the new version: no reload');
    assert.ok(!ran('workbench.action.restartExtensionHost'), 'plain restart would keep the old version');
  } finally {
    b.dispose();
    done();
  }
});

test('agent update: without the Mk42 restart command (older build) or when it changes nothing, apply reloads the window', async () => {
  const { dir, done } = setup();
  install(dir, '2.1.314');
  const b = new AgentUpdateButton(() => 'agent-claude', () => undefined, silent);
  try {
    vs.state.answers.push('업데이트 적용');
    await b.apply();
    assert.ok(ran('workbench.action.reloadWindow'));
    vs.state.executed = [];
    vs.state.commandImpl.set(RESTART_UPDATED_COMMAND, () => 0);
    vs.state.answers.push('업데이트 적용');
    await b.apply();
    assert.ok(ran(RESTART_UPDATED_COMMAND) && ran('workbench.action.reloadWindow'));
  } finally {
    b.dispose();
    done();
  }
});

test('agent update: up to date says so; a failed or skipped check shows why; no daemon still offers a reload', async () => {
  const { done } = setup();
  const reply = (updates: unknown[]) => () => ({ request: async () => ({ updates }) }) as never;
  try {
    const cases: [unknown[], string, string][] = [
      [[{ id: ID, status: 'current', installed: '2.1.312', latest: '2.1.312' }], 'info', '최신'],
      [[{ id: ID, status: 'failed', error: 'HTTP 503' }], 'warn', 'HTTP 503'],
      [[], 'warn', '확인하지 않았어요'],
      [[{ id: ID, status: 'updated', installed: '2.1.314' }], 'warn', '보이지 않아요'],
    ];
    for (const [updates, level, text] of cases) {
      vs.state.messages = [];
      const b = new AgentUpdateButton(() => 'agent-claude', reply(updates), silent);
      await b.check();
      assert.ok(vs.state.messages.some((m) => m.level === level && m.text.includes(text)), `${text}: ${JSON.stringify(vs.state.messages)}`);
      b.dispose();
    }
    vs.state.messages = [];
    const off = new AgentUpdateButton(() => 'agent-claude', () => undefined, silent);
    await off.check();
    assert.ok(vs.state.messages.some((m) => m.level === 'warn' && m.text.includes('데몬')));
    off.dispose();
  } finally {
    done();
  }
});

test('agent update: an unverified new version shows the warning button and asks with the disclaimer before anything is installed', async () => {
  const { dir, done } = setup();
  const calls: unknown[] = [];
  const pending = { id: ID, installed: '2.1.312', latest: '2.1.315', status: 'pending', verification: 'unverified', pending: '2.1.315', reason: 'no Marketplace build to compare with' };
  const api = {
    request: async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === 'extensions.status') return { updates: [pending] };
      if (method === 'extensions.installUnverified') {
        install(dir, '2.1.315');
        return { ...pending, status: 'updated', installed: '2.1.315', installedVerification: 'unverified' };
      }
      return { updates: [pending] };
    },
  };
  const b = new AgentUpdateButton(() => 'agent-claude', () => api as never, silent);
  try {
    await b.refresh();
    assert.equal(flags(UPDATE_UNVERIFIED_CONTEXT).at(-1), true, 'warning button');
    // 나중에(취소): 아무것도 깔지 않아요
    await b.check();
    const ask = vs.state.messages.find((m) => m.text.includes('검증되지 않은 새 버전'));
    assert.ok(ask, 'asks');
    assert.ok(!calls.some((c) => (c as unknown[])[0] === 'extensions.installUnverified'), 'declined: nothing installed');
    // 위험을 감수하고 설치 → 그 버전만 → 적용할지 물음
    vs.state.answers.push('위험을 감수하고 설치', undefined);
    await b.check();
    assert.deepEqual(calls.find((c) => (c as unknown[])[0] === 'extensions.installUnverified'), ['extensions.installUnverified', { id: ID, version: '2.1.315' }]);
    assert.ok(vs.state.messages.some((m) => m.text === '업데이트를 적용할까요?'));
  } finally {
    b.dispose();
    done();
  }
});

test('agent update: a build that differs from the official build is explained as blocked; the VSIX path stays open', async () => {
  const { done } = setup();
  const blocked = { id: ID, installed: '2.1.312', latest: '2.1.313', status: 'blocked', verification: 'mismatch', reason: '3 differ, 0 missing, 1 extra files' };
  const api = { request: async (method: string) => (method === 'extensions.status' ? { updates: [] } : { updates: [blocked] }) };
  const b = new AgentUpdateButton(() => 'agent-claude', () => api as never, silent);
  try {
    vs.state.answers.push('VSIX에서 직접 설치…');
    await b.check();
    assert.ok(vs.state.messages.some((m) => m.level === 'error' && m.text.includes('공식 판과 달라서 설치하지 않았어요')));
    assert.ok(ran('workbench.extensions.action.installVSIX'), 'manual VSIX install offered');
  } finally {
    b.dispose();
    done();
  }
});

test('agent update: the running version (with its verification) is shown left of the buttons on both agent views; clicking it checks', async () => {
  const { done } = setup();
  const labels: unknown[][] = [];
  vs.state.commandImpl.set(SET_TITLE_LABEL_COMMAND, (...a: unknown[]) => void labels.push(a));
  const api = { request: async () => ({ updates: [{ id: ID, installed: '2.1.312', installedVerification: 'verified', status: 'current' }] }) };
  const b = new AgentUpdateButton(() => 'agent-claude', () => api as never, silent);
  try {
    await b.refresh();
    assert.deepEqual(
      labels.map((l) => [l[0], l[1], l[3]]),
      [
        ['claudeVSCodeSidebarSecondary', '2.1.312 ✓', 'mark42.agentUpdate.check'],
        ['claudeVSCodeSidebar', '2.1.312 ✓', 'mark42.agentUpdate.check'],
      ],
    );
    assert.match(String(labels[0]![2]), /대조 검증됨/);
    await b.refresh();
    assert.equal(labels.length, 2, 'unchanged: not re-registered');
  } finally {
    b.dispose();
    done();
  }
});

test('agent update: the reload button is separate — it restarts after confirmation, and uses the new version when one is installed; check never reloads', async () => {
  const { dir, done } = setup();
  const b = new AgentUpdateButton(() => 'agent-claude', () => ({ request: async (m: string) => (m === 'extensions.status' ? { updates: [] } : { updates: [{ id: ID, status: 'current', installed: '2.1.312', latest: '2.1.312' }] }) }) as never, silent);
  try {
    await b.check();
    assert.ok(!ran('workbench.action.restartExtensionHost') && !ran('workbench.action.reloadWindow'), 'check alone never reloads');
    assert.ok(vs.state.messages.some((m) => m.text.includes('최신')));
    vs.state.answers.push('다시 로드');
    await vs.commands.executeCommand(AGENT_RELOAD_COMMAND);
    assert.ok(ran('workbench.action.restartExtensionHost'));
    vs.state.executed = [];
    install(dir, '2.1.314');
    vs.state.commandImpl.set(RESTART_UPDATED_COMMAND, () => 1);
    vs.state.answers.push('업데이트 적용');
    await vs.commands.executeCommand(AGENT_RELOAD_COMMAND);
    assert.ok(ran(RESTART_UPDATED_COMMAND) && !ran('workbench.action.restartExtensionHost'), 'a plain restart would bring the old version back');
  } finally {
    b.dispose();
    done();
  }
});

test('agent update: first run — the agent extension is missing and waits for approval: asked once, installed, then reload offered', async () => {
  vs.reset();
  const dir = mkdtempSync(join(tmpdir(), 'mk42-upd-'));
  const calls: string[] = [];
  const pending = { id: ID, latest: '2.1.315', status: 'pending', verification: 'unverified', pending: '2.1.315', reason: 'no official build hashes to compare with' };
  const api = {
    request: async (method: string) => {
      calls.push(method);
      if (method === 'extensions.installUnverified') return { ...pending, status: 'updated', installed: '2.1.315', installedVerification: 'unverified' };
      return { updates: [pending] };
    },
  };
  const b = new AgentUpdateButton(() => 'agent-claude', () => api as never, silent);
  try {
    vs.state.answers.push('위험을 감수하고 설치', '다시 불러오기');
    await b.refresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(vs.state.messages.some((m) => m.text.includes('검증되지 않은 새 버전')), 'asks without any button of the missing extension');
    assert.ok(calls.includes('extensions.installUnverified'));
    assert.ok(vs.state.messages.some((m) => m.text.includes('창을 다시 불러와 시작할까요')), 'offers a reload');
    const asked = vs.state.messages.filter((m) => m.text.includes('검증되지 않은 새 버전')).length;
    await b.refresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(vs.state.messages.filter((m) => m.text.includes('검증되지 않은 새 버전')).length, asked, 'once per version');
  } finally {
    b.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
