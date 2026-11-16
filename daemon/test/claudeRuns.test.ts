// «실행» 보기(터미널 명령)·서브에이전트 모델/effort — 본 세션 transcript 해석과 수집기 연결.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyRunRecord, BG_STALE_MS, newRunsState, runsOf, RUNS_PER_SESSION } from '../src/tasks/claudeRuns.ts';
import { createClaudeTaskCollector, RUNS_TAIL_BYTES } from '../src/tasks/claudeTasks.ts';
import { createCodexTaskCollector } from '../src/tasks/codexTasks.ts';
import { tempDir } from './helpers.ts';

const T0 = Date.parse('2026-11-16T00:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function bash(id: string, s: number, input: Record<string, unknown>, name = 'Bash', msgId = `msg-${id}`) {
  return { type: 'assistant', timestamp: at(s), message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}
function text(s: number, msgId: string) {
  return { type: 'assistant', timestamp: at(s), message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
}
function result(id: string, s: number, extra: Record<string, unknown> = {}, isError = false) {
  return {
    type: 'user',
    timestamp: at(s),
    toolUseResult: { stdout: 'x', stderr: '', interrupted: false, isImage: false, ...extra },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'secret output', is_error: isError }] },
  };
}
function note(s: number, taskId: string, toolUseId: string | undefined, status: string) {
  const body = `<task-notification><task-id>${taskId}</task-id>${toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>` : ''}<status>${status}</status><summary>s</summary></task-notification>`;
  return { type: 'user', timestamp: at(s), message: { role: 'user', content: body } };
}

test('runs: foreground done/failed, description as label (never the command), tool fallback', () => {
  const st = newRunsState();
  applyRunRecord(st, bash('t1', 0, { command: 'rm -rf secret', description: 'Run  the\nunit tests' }, 'Bash', 'm1'));
  applyRunRecord(st, bash('t2', 1, { command: 'Get-Thing' }, 'PowerShell', 'm1'));
  applyRunRecord(st, bash('t3', 2, { command: 'false', description: 'Fails' }, 'Bash', 'm1'));
  applyRunRecord(st, result('t1', 10));
  applyRunRecord(st, result('t3', 12, {}, true));
  const runs = runsOf(st, T0 + 20_000, 0);
  const by = Object.fromEntries(runs.map((r) => [r.id, r]));
  assert.deepEqual(
    { label: by.t1!.label, status: by.t1!.status, endedAt: by.t1!.endedAt, background: by.t1!.background, tool: by.t1!.tool },
    { label: 'Run the unit tests', status: 'done', endedAt: at(10), background: false, tool: 'Bash' },
  );
  assert.equal(by.t2!.label, 'PowerShell');
  assert.equal(by.t2!.status, 'running');
  assert.equal(by.t3!.status, 'failed');
  assert.equal(runs[0]!.id, 't2', 'running first');
  assert.ok(!JSON.stringify(runs).includes('rm -rf') && !JSON.stringify(runs).includes('secret output'), 'no command text or output');
});

test('runs: background via run_in_background or a backgroundTaskId result, ended by notification (tool-use-id or task-id), queued_command, TaskStop', () => {
  const st = newRunsState();
  applyRunRecord(st, bash('b1', 0, { command: 'npm run dev', description: 'Dev server', run_in_background: true }));
  applyRunRecord(st, result('b1', 1, { backgroundTaskId: 'task1' }));
  applyRunRecord(st, bash('b2', 2, { command: 'long', description: 'Long build' }));
  applyRunRecord(st, result('b2', 3, { backgroundTaskId: 'task2' })); // 도중에 백그라운드로
  applyRunRecord(st, bash('b3', 4, { command: 'x', description: 'Third', run_in_background: true }));
  applyRunRecord(st, result('b3', 5, { backgroundTaskId: 'task3' }));
  applyRunRecord(st, bash('b4', 6, { command: 'y', description: 'Fourth', run_in_background: true }));
  applyRunRecord(st, result('b4', 7, { backgroundTaskId: 'task4' }));
  let runs = runsOf(st, T0 + 60_000, 0);
  assert.ok(runs.every((r) => r.status === 'running' && r.background));
  assert.equal(runs.find((r) => r.id === 'b2')!.taskId, 'task2');
  applyRunRecord(st, note(100, 'task1', 'b1', 'completed'));
  applyRunRecord(st, note(101, 'task2', undefined, 'failed')); // tool-use-id 없이 task-id로
  applyRunRecord(st, { type: 'attachment', timestamp: at(102), attachment: { type: 'queued_command', prompt: note(0, 'task3', 'b3', 'killed').message.content } });
  applyRunRecord(st, bash('stop', 103, { task_id: 'task4' }, 'TaskStop'));
  applyRunRecord(st, note(104, 'task-other', 'toolu_wf', 'completed')); // 다른 작업 알림은 무시
  runs = runsOf(st, T0 + 200_000, 0);
  const by = Object.fromEntries(runs.map((r) => [r.id, r]));
  assert.deepEqual(
    ['b1', 'b2', 'b3', 'b4'].map((id) => [by[id]!.status, by[id]!.endedAt]),
    [
      ['done', at(100)],
      ['failed', at(101)],
      ['failed', at(102)],
      ['failed', at(103)],
    ],
  );
  // 이미 끝난 명령은 늦은 알림으로 바뀌지 않아요
  applyRunRecord(st, note(300, 'task1', 'b1', 'failed'));
  assert.equal(runsOf(st, T0 + 400_000, 0).find((r) => r.id === 'b1')!.status, 'done');
});

test('runs: no end record → a foreground command stays running (permission prompt) until a later reply arrives without its result; background stale after 12h', () => {
  const st = newRunsState();
  applyRunRecord(st, bash('g1', 0, { command: 'c', description: 'Bg', run_in_background: true }));
  applyRunRecord(st, result('g1', 0, { backgroundTaskId: 'k1' }));
  applyRunRecord(st, bash('d1', 0, { command: 'd', description: 'Done early' }));
  applyRunRecord(st, result('d1', 1));
  // 한 응답의 병렬 호출 두 개(같은 message id) — 서로를 끝난 걸로 보지 않아요
  applyRunRecord(st, bash('f1', 2, { command: 'a', description: 'Waits for approval' }, 'Bash', 'm1'));
  applyRunRecord(st, bash('f2', 2, { command: 'b', description: 'Parallel' }, 'Bash', 'm1'));
  const status = (t: number, cutoff = 0) => Object.fromEntries(runsOf(st, T0 + t, cutoff).map((r) => [r.id, r.status]));
  assert.deepEqual(status(3_600_000), { f1: 'running', f2: 'running', g1: 'running', d1: 'done' }, 'no time limit while nothing else happens');
  applyRunRecord(st, result('f2', 10));
  applyRunRecord(st, text(20, 'm2'));
  assert.deepEqual(status(30_000), { f1: 'stale', f2: 'done', g1: 'running', d1: 'done' }, 'a later reply without f1 result');
  const stale = runsOf(st, T0 + 30_000, 0).find((r) => r.id === 'f1')!;
  assert.equal(stale.endedAt, undefined);
  assert.equal(status(BG_STALE_MS + 1000).g1, 'stale');
  assert.equal(status(10_000, T0 + 5_000).d1, undefined, 'ended before the window');
});

test('runs: at most RUNS_PER_SESSION are listed, running first then most recent', () => {
  const st = newRunsState();
  for (let i = 0; i < RUNS_PER_SESSION + 10; i++) {
    applyRunRecord(st, bash(`r${i}`, i, { command: 'x', description: `n${i}` }, 'Bash', 'm1'));
    if (i !== 3) applyRunRecord(st, result(`r${i}`, i + 0.5));
  }
  const runs = runsOf(st, T0 + 60_000, 0);
  assert.equal(runs.length, RUNS_PER_SESSION);
  assert.equal(runs[0]!.id, 'r3');
  assert.equal(runs[1]!.id, `r${RUNS_PER_SESSION + 9}`);
});

test('collector: a session with only a main transcript lists its runs; subagents carry model and effort; big transcripts start at the tail', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const claudeDir = join(dir, 'claude');
    const proj = join(claudeDir, 'projects', 'C--work-proj');
    mkdirSync(proj, { recursive: true });
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const SID = '11111111-2222-4333-8444-555555555555';
    const main = join(proj, `${SID}.jsonl`);
    // 앞쪽은 버려질 만큼 길게(끝 RUNS_TAIL_BYTES만 읽어요) — 그 안의 명령은 보이지 않아요
    writeFileSync(main, `${JSON.stringify({ ...bash('old', 0, { command: 'x', description: 'Too early' }), timestamp: iso(5000) })}\n`);
    appendFileSync(main, `${JSON.stringify({ type: 'user', timestamp: iso(4000), message: { role: 'user', content: 'p'.repeat(RUNS_TAIL_BYTES + 10) } })}\n`);
    appendFileSync(main, `${JSON.stringify({ ...bash('t1', 0, { command: 'x', description: 'Build it', run_in_background: true }), timestamp: iso(3000) })}\n`);
    const c = createClaudeTaskCollector({ claudeDir });
    // 전체 목록(통합 창)에는 명령만 있는 세션이 나오지 않아요
    assert.deepEqual(await c.collect({}), []);
    let [s] = await c.collect({ sessionId: SID });
    assert.deepEqual(s?.runs?.map((r) => [r.id, r.label, r.status]), [['t1', 'Build it', 'running']]);
    assert.deepEqual([s!.workflows.length, s!.subagents.length, s!.running], [0, 0, 0], 'runs are not counted as background agents');
    // 덧붙은 줄만 읽어요
    appendFileSync(main, `${JSON.stringify({ ...result('t1', 0, { backgroundTaskId: 'k1' }), timestamp: iso(2000) })}\n`);
    appendFileSync(main, `${JSON.stringify({ ...note(0, 'k1', 't1', 'completed'), timestamp: iso(1000) })}\n`);
    [s] = await c.collect({ sessionId: SID });
    assert.equal(s?.runs?.[0]?.status, 'done');

    // 서브에이전트: 마지막 응답의 모델·effort(합성 응답은 건너뛰고, 없으면 requestedModel)
    const sub = join(proj, SID, 'subagents');
    mkdirSync(sub, { recursive: true });
    const rec = (model: string | undefined, effort: string | undefined, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ type: 'assistant', timestamp: iso(500), effort, ...extra, message: { id: `m${Math.random()}`, role: 'assistant', model, usage: { input_tokens: 1, output_tokens: 1 }, content: [] } })}\n`;
    writeFileSync(join(sub, 'agent-a1.jsonl'), rec('claude-opus-5-5', 'high') + rec('<synthetic>', undefined));
    writeFileSync(join(sub, 'agent-a2.jsonl'), rec(undefined, 'low', { requestedModel: 'claude-sonnet-5-5[1m]' }));
    [s] = await c.collect({ sessionId: SID });
    const ag = Object.fromEntries(s!.subagents.map((a) => [a.id, [a.model, a.effort]]));
    assert.deepEqual(ag, { a1: ['claude-opus-5-5', 'high'], a2: ['claude-sonnet-5-5', 'low'] });
  } finally {
    cleanup();
  }
});

test('codex: sub-threads carry model and reasoning effort from the state db', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const home = join(dir, 'codex');
    mkdirSync(home, { recursive: true });
    const d = new DatabaseSync(join(home, 'state_5.sqlite'));
    d.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT, cwd TEXT, title TEXT, agent_nickname TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER, model TEXT, reasoning_effort TEXT)`);
    d.exec('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)');
    const now = Date.now();
    const ins = d.prepare('INSERT INTO threads (id, rollout_path, source, cwd, title, agent_nickname, created_at_ms, updated_at_ms, model, reasoning_effort) VALUES (?,?,?,?,?,?,?,?,?,?)');
    ins.run('p1', '', 'vscode', 'C:\\w', 'Parent', null, now - 5000, now - 1000, 'gpt-6-luna', 'low');
    ins.run('c1', '', 'vscode', 'C:\\w', 'Child', 'Planck', now - 4000, now - 1000, 'gpt-6-astra', 'xhigh');
    d.prepare('INSERT INTO thread_spawn_edges VALUES (?,?,?)').run('p1', 'c1', 'open');
    d.close();
    const [s] = await createCodexTaskCollector({ codexHome: home }).collect({});
    assert.deepEqual(s?.subagents.map((a) => [a.id, a.model, a.effort]), [['c1', 'gpt-6-astra', 'xhigh']]);
  } finally {
    cleanup();
  }
});
