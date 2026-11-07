import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSessionBinder } from '../src/claudeSessions.ts';
import {
  isSessionRegistryFile,
  parseClaudeSessionFile,
  pickClaudeSession,
  resolveByParent,
  resolveWithoutParents,
  UNVERIFIED_FRESH_MS,
  type ClaudeSessionEntry,
} from '../src/lib/claudeBinding.ts';

const folder = 'C:\\Dev\\proj';
const t0 = 1_800_000_000_000;

function e(pid: number, sessionId: string, startedAt: number, cwd = folder, entrypoint = 'claude-vscode'): ClaudeSessionEntry {
  return { pid, sessionId, cwd, startedAt, entrypoint };
}

test('registry file filter never matches credential key files', () => {
  assert.equal(isSessionRegistryFile('12345.json'), true);
  assert.equal(isSessionRegistryFile('12345.abcdef.key'), false);
  assert.equal(isSessionRegistryFile('12345.json.key'), false);
  assert.equal(isSessionRegistryFile('notes.json'), false);
});

test('parse keeps only known fields', () => {
  const p = parseClaudeSessionFile(JSON.stringify({ pid: 1, sessionId: 's', cwd: 'C:\\x', startedAt: 5, name: 'secret title', status: 'idle' }));
  assert.deepEqual(p, { pid: 1, sessionId: 's', cwd: 'C:\\x', startedAt: 5, status: 'idle' });
  assert.equal(parseClaudeSessionFile('{'), undefined);
  assert.equal(parseClaudeSessionFile(JSON.stringify({ pid: 'x' })), undefined);
});

test('single fresh candidate in same folder binds (case-insensitive path)', () => {
  const entries = [e(1, 'old', t0 - 60_000), e(2, 'new', t0 + 1000, 'c:\\dev\\PROJ\\'), e(3, 'other', t0 + 2000, 'C:\\Other')];
  const r = pickClaudeSession(entries, { folderPath: folder, openedAt: t0, excludeSessionIds: new Set() });
  assert.deepEqual(r, { status: 'bound', sessionId: 'new', pid: 2, via: 'single' });
});

test('pre-existing sessions and non-vscode entrypoints are excluded', () => {
  const entries = [e(1, 'known', t0 + 10), e(2, 'cli', t0 + 20, folder, 'cli')];
  const r = pickClaudeSession(entries, { folderPath: folder, openedAt: t0, excludeSessionIds: new Set(['known']) });
  assert.deepEqual(r, { status: 'none' });
});

test('without parent pids only a single candidate that started right after opening binds', () => {
  assert.deepEqual(resolveWithoutParents([e(2, 'n', t0 + 3000)], t0), { status: 'bound', sessionId: 'n', pid: 2, via: 'single' });
  assert.deepEqual(resolveWithoutParents([e(2, 'late', t0 + UNVERIFIED_FRESH_MS + 1)], t0), { status: 'none' }, 'appeared long after opening');
  assert.deepEqual(resolveWithoutParents([e(2, 'nostart', 0)], t0), { status: 'none' });
  assert.equal(resolveWithoutParents([e(2, 'a', t0 + 1), e(3, 'b', t0 + 2)], t0).status, 'ambiguous');
});

test('binder: a single candidate from another window is rejected; binds when this host’s child appears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm42-bind-'));
  const silent = { info() {}, warn() {}, error() {}, debug() {}, show() {} };
  let kids = '';
  let lookups = 0;
  const runner = async () => {
    lookups++;
    return { code: 0, stdout: kids, stderr: '' };
  };
  const binder = new ClaudeSessionBinder(silent, runner, dir, 'win32');
  try {
    const openedAt = Date.now();
    const p = binder.waitForNewSession({ folderPath: folder, openedAt, excludeSessionIds: new Set(), timeoutMs: 5000, hostPid: 777, pollMs: 20 });
    // 다른 창(B)의 세션이 먼저 떠요 — 이 창(A)의 자식이 아니에요
    writeFileSync(join(dir, '900.json'), JSON.stringify({ pid: 900, sessionId: 'other-window', cwd: folder, startedAt: openedAt + 100, entrypoint: 'claude-vscode' }));
    await new Promise((r) => setTimeout(r, 200));
    const afterReject = lookups;
    assert.ok(afterReject >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lookups, afterReject, 'rejected candidates are not looked up again');
    kids = '901\r\n';
    writeFileSync(join(dir, '901.json'), JSON.stringify({ pid: 901, sessionId: 'mine', cwd: folder, startedAt: openedAt + 5000, entrypoint: 'claude-vscode' }));
    assert.equal(await p, 'mine');
  } finally {
    binder.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous candidates resolved by parent pid of this extension host', () => {
  const entries = [e(10, 'a', t0 + 100), e(11, 'b', t0 + 200)];
  const r = pickClaudeSession(entries, { folderPath: folder, openedAt: t0, excludeSessionIds: new Set() });
  assert.equal(r.status, 'ambiguous');
  if (r.status !== 'ambiguous') return;
  assert.deepEqual(r.candidates.map((c) => c.sessionId), ['b', 'a']);
  const parents = new Map<number, number | undefined>([
    [10, 777],
    [11, 999],
  ]);
  assert.deepEqual(resolveByParent(r.candidates, parents, 777), { status: 'bound', sessionId: 'a', pid: 10, via: 'parentPid' });
  assert.deepEqual(resolveByParent(r.candidates, parents, 123), { status: 'none' });
});
