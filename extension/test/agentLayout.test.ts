// 에이전트 창 레이아웃: 뜰 때·편집기가 다 닫힐 때 에이전트 패널(보조 사이드바)을 다시 최대화
import { test, beforeEach } from 'node:test';
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
const layout = (await import('../src/agentLayout.ts')) as typeof import('../src/agentLayout.ts');

const maximized = () => vs.state.executed.filter((e) => e.id === layout.MAXIMIZE_AUX_COMMAND).length;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => vs.reset());

test('agent window: maximized once it has settled when no editor is open, and again when the last tab closes', async () => {
  const d = layout.watchAgentLayout(() => true, 0);
  await tick();
  assert.equal(maximized(), 1);

  vs.state.tabGroups = [{ tabs: [{}] }];
  vs.state.tabsChanged.fire({ opened: [{}], changed: [], closed: [] });
  await tick();
  assert.equal(maximized(), 1, 'opening a file is left alone');

  vs.state.tabsChanged.fire({ opened: [], changed: [], closed: [{}] });
  await tick();
  assert.equal(maximized(), 1, 'still a tab open');

  vs.state.tabGroups = [{ tabs: [] }];
  vs.state.tabsChanged.fire({ opened: [], changed: [], closed: [{}] });
  await tick();
  assert.equal(maximized(), 2);
  d.dispose();
});

test('agent window that restores with an editor open is not maximized at start', async () => {
  vs.state.tabGroups = [{ tabs: [{}] }];
  const d = layout.watchAgentLayout(() => true, 0);
  await tick();
  assert.equal(maximized(), 0);
  d.dispose();
});

test('non-agent windows are never touched', async () => {
  const d = layout.watchAgentLayout(() => false, 0);
  await tick();
  vs.state.tabsChanged.fire({ opened: [], changed: [], closed: [{}] });
  await tick();
  assert.equal(maximized(), 0);
  d.dispose();
});
