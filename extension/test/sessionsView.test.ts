import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SessionSummary } from '@mark42/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(join(here, 'helpers', 'vscode-stub.ts')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true, format: 'module' };
    return next(specifier, context);
  },
});
await import(stubUrl); // 먼저 TS로 불러 둬요(훅의 format:'module'로 처음 불리면 타입 문법에서 깨져요)
const { sessionChildren } =(await import('../src/sessionsView.ts')) as typeof import('../src/sessionsView.ts');

const s = (id: string, parentId?: string): SessionSummary => ({
  agent: 'codex',
  id,
  cwd: 'C:\\p',
  updatedAt: '2026-10-17T00:00:00Z',
  ...(parentId ? { isSubagent: true, parentId } : {}),
});

test('sessions tab tree nests grandchildren (subagent of a subagent) and survives cycles', () => {
  const list = [s('T'), s('S1', 'T'), s('S2', 'S1'), s('X', 'Y'), s('Y', 'X')];
  const byParent = new Map<string, SessionSummary[]>();
  for (const x of list) if (x.parentId) byParent.set(x.parentId, [...(byParent.get(x.parentId) ?? []), x]);
  const root = { type: 'session' as const, s: list[0]!, pinned: undefined, byParent, ancestors: new Set<string>() };
  const lvl1 = sessionChildren(root);
  assert.deepEqual(lvl1.map((n) => n.s.id), ['S1']);
  const lvl2 = sessionChildren(lvl1[0]!);
  assert.deepEqual(lvl2.map((n) => n.s.id), ['S2']);
  assert.deepEqual(sessionChildren(lvl2[0]!), []);
  const x = { type: 'session' as const, s: list[3]!, pinned: undefined, byParent, ancestors: new Set<string>() };
  const y = sessionChildren(x);
  assert.deepEqual(y.map((n) => n.s.id), ['Y']);
  assert.deepEqual(sessionChildren(y[0]!), [], 'cycle stops');
});
