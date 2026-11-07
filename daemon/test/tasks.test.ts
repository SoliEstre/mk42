// 백그라운드 작업 수집기·모니터 — 임시 폴더에 Claude projects·Codex state DB 픽스처를 만들어요.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, openSync, utimesSync, writeFileSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import type { SessionTasks } from '@mark42/protocol';
import { normalizePath } from '@mark42/protocol/paths';
import { createClaudeTaskCollector, parseWorkflowScriptMeta, type TaskCollector } from '../src/tasks/claudeTasks.ts';
import { createCodexTaskCollector, rootThread } from '../src/tasks/codexTasks.ts';
import { readAppended, newCursor, TASKS_TUNING, toolActivity } from '../src/tasks/common.ts';
import { createTaskMonitor } from '../src/tasks/taskMonitor.ts';
import { tempDir, until } from './helpers.ts';

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PROJ = 'C--work-proj';
const CWD = 'C:\\work\\proj';
const RUN = 'wf_abc12345-001';
const HOUR = 60 * 60 * 1000;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function line(o: unknown): string {
  return `${JSON.stringify(o)}\n`;
}

function assistant(id: string, usage: Record<string, number>, content: unknown[], msAgo = 1000): string {
  return line({ type: 'assistant', timestamp: iso(msAgo), cwd: CWD, sessionId: SID, message: { id, role: 'assistant', usage, content } });
}

function user(text: string, msAgo = 2000): string {
  return line({ type: 'user', timestamp: iso(msAgo), cwd: CWD, sessionId: SID, message: { role: 'user', content: text } });
}

const U1 = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };
const U2 = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };

function setOld(p: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(p, t, t);
}

interface ClaudeFixture {
  claudeDir: string;
  sessionDir: string;
  sub: string;
  wfDir: string;
}

function buildClaude(root: string): ClaudeFixture {
  const claudeDir = join(root, 'claude');
  const projDir = join(claudeDir, 'projects', PROJ);
  const sessionDir = join(projDir, SID);
  const sub = join(sessionDir, 'subagents');
  const wfDir = join(sub, 'workflows', RUN);
  mkdirSync(wfDir, { recursive: true });
  mkdirSync(join(sessionDir, 'workflows', 'scripts'), { recursive: true });

  // 본 세션 transcript: cwd + AI 제목
  writeFileSync(join(projDir, `${SID}.jsonl`), user('secret prompt text', 5000) + line({ type: 'ai-title', aiTitle: 'Fix the widget' }));

  // a-done: 같은 message.id가 세 줄(usage 되풀이) + 다른 메시지 하나, meta.finished
  writeFileSync(
    join(sub, 'agent-adone.jsonl'),
    user('do the thing', 9000) +
      assistant('msg_1', U1, [{ type: 'thinking', thinking: 'hmm' }], 8000) +
      assistant('msg_1', U1, [{ type: 'text', text: 'private words' }], 8000) +
      assistant('msg_1', U1, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\secret\\dir\\notes.md' } }], 8000) +
      assistant('msg_2', U2, [{ type: 'text', text: 'done' }], 7000),
  );
  writeFileSync(join(sub, 'agent-adone.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find widget files', finished: true, toolUseId: 'x', spawnDepth: 1 }));

  // a-run: 안 끝남, 방금 씀. 마지막 도구는 명령이 든 Bash
  writeFileSync(
    join(sub, 'agent-arun.jsonl'),
    assistant('msg_3', U2, [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'x' } }], 3000) +
      assistant('msg_4', U2, [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'rm -rf /very/secret && echo TOKEN=abc', description: 'secret desc' } }], 2000),
  );
  writeFileSync(join(sub, 'agent-arun.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Implement widget', finished: false }));

  // a-stale: 안 끝남, 1시간 전
  writeFileSync(join(sub, 'agent-astale.jsonl'), assistant('msg_5', U2, [], HOUR) + 'not json\n{"broken":\n');
  writeFileSync(join(sub, 'agent-astale.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Plan it' }));
  setOld(join(sub, 'agent-astale.jsonl'), HOUR);

  // a-old: 창(12시간) 밖
  writeFileSync(join(sub, 'agent-aold.jsonl'), assistant('msg_6', U1, [], 20 * HOUR));
  setOld(join(sub, 'agent-aold.jsonl'), 20 * HOUR);

  // 워크플로우: 스크립트 meta + journal(시작 3, 결과 1, 실패 1) + agent 파일
  writeFileSync(
    join(sessionDir, 'workflows', 'scripts', `demo-review-${RUN}.js`),
    [
      'export const meta = {',
      "  name: 'demo-review',",
      '  // 주석 속 name: \'nope\'',
      "  description: 'Review the \\'demo\\' change',",
      "  phases: [{ title: 'Review', detail: 'look' }, { title: \"Verify\" }, { title: `Fix` }],",
      '}',
      "const CTX = `name: 'not this'`",
      'process.exit(1) // 실행하면 안 돼요',
    ].join('\n'),
  );
  writeFileSync(
    join(wfDir, 'journal.jsonl'),
    line({ type: 'launched' }) +
      line({ type: 'started', key: 'k1', agentId: 'w1', label: 'review:runtime', phase: 'Review' }) +
      line({ type: 'started', key: 'k2', agentId: 'w2', label: 'review:safety', phase: 'Review' }) +
      line({ type: 'result', key: 'k1', agentId: 'w1', result: { summary: `  Found ${'x'.repeat(400)}`, findings: [] } }) +
      line({ type: 'failed', key: 'k2', agentId: 'w2' }) +
      line({ type: 'started', key: 'k3', agentId: 'w3', label: 'verify:1', phase: 'Verify' }),
  );
  writeFileSync(join(wfDir, 'agent-w1.jsonl'), assistant('m_w1', U1, [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'password=', path: 'C:\\repo\\src' } }], 6000));
  writeFileSync(join(wfDir, 'agent-w1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'review runtime', workflowPhase: 'Review' }));
  writeFileSync(join(wfDir, 'agent-w2.jsonl'), assistant('m_w2', U2, [], 5000));
  writeFileSync(join(wfDir, 'agent-w3.jsonl'), assistant('m_w3', U2, [], 1000));

  // 다른 세션: subagents 폴더만 있고 비어 있음 → 목록에 안 나와요
  mkdirSync(join(projDir, SID2, 'subagents'), { recursive: true });
  return { claudeDir, sessionDir, sub, wfDir };
}

function only(list: SessionTasks[], sessionId: string): SessionTasks {
  const s = list.find((x) => x.sessionId === sessionId);
  assert.ok(s, `session ${sessionId} listed`);
  return s;
}

describe('claude tasks', () => {
  let t: ReturnType<typeof tempDir>;
  let fx: ClaudeFixture;
  let c: TaskCollector;
  before(() => {
    t = tempDir('m42d-tasks-');
    fx = buildClaude(t.dir);
    c = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
  });
  after(() => t.cleanup());

  it('lists subagents with deduped tokens, status, kind, label and file-only activity', async () => {
    const list = await c.collect({});
    assert.equal(list.length, 1);
    const s = only(list, SID);
    assert.equal(s.agent, 'claude');
    assert.equal(s.cwd, normalizePath(CWD));
    assert.equal(s.title, 'Fix the widget');
    const ids = s.subagents.map((a) => a.id);
    assert.ok(!ids.includes('aold'), 'outside sinceMs');
    assert.equal(ids[0], 'arun', 'running first');
    const done = s.subagents.find((a) => a.id === 'adone')!;
    assert.equal(done.status, 'done');
    assert.equal(done.kind, 'Explore');
    assert.equal(done.label, 'Find widget files');
    // msg_1이 세 줄이어도 한 번만. total은 Claude Code처럼 마지막 응답(msg_2)의 문맥 1 + 3 + 4
    assert.deepEqual(done.tokens, { input: 11, output: 22, cacheRead: 103, cacheCreation: 9, total: 8 });
    assert.equal(done.activity, 'Read notes.md');
    assert.ok(done.startedAt && done.endedAt);
    const run = s.subagents.find((a) => a.id === 'arun')!;
    assert.equal(run.status, 'running');
    assert.equal(run.activity, 'Bash');
    assert.equal(s.subagents.find((a) => a.id === 'astale')!.status, 'stale');
    // 명령·본문·프롬프트는 결과 어디에도 없어요
    const json = JSON.stringify(list);
    for (const secret of ['rm -rf', 'TOKEN', 'secret desc', 'secret prompt', 'private words', 'password=', 'C:\\\\secret', 'process.exit']) {
      assert.ok(!json.includes(secret), `no "${secret}" in output`);
    }
  });

  it('builds workflows from script meta + journal + agent files', async () => {
    const s = only(await c.collect({}), SID);
    assert.equal(s.workflows.length, 1);
    const wf = s.workflows[0]!;
    assert.equal(wf.runId, RUN);
    assert.equal(wf.name, 'demo-review');
    assert.equal(wf.description, "Review the 'demo' change");
    assert.deepEqual(wf.phases, [
      { title: 'Review', started: 2, done: 2 },
      { title: 'Verify', started: 1, done: 0 },
      { title: 'Fix', started: 0, done: 0 },
    ]);
    assert.deepEqual(wf.progress, { done: 2, total: 3 });
    assert.equal(wf.status, 'running');
    const w1 = wf.agents.find((a) => a.id === 'w1')!;
    assert.equal(w1.status, 'done');
    assert.equal(w1.label, 'review:runtime');
    assert.equal(w1.phase, 'Review');
    assert.equal(w1.kind, 'workflow-subagent');
    assert.equal(w1.activity, 'Grep src');
    assert.ok(w1.summary!.startsWith('Found xxx'));
    assert.ok(w1.summary!.length <= 300);
    assert.equal(wf.agents.find((a) => a.id === 'w2')!.status, 'failed');
    assert.equal(wf.agents.find((a) => a.id === 'w3')!.status, 'running');
    assert.equal(wf.tokens.total, 115 + 8 + 8);
    // 세션 합계 = 서브에이전트(adone 8 + arun 8 + astale 8) + 워크플로우(131), running = arun + w3
    assert.equal(s.tokens.total, 8 + 8 + 8 + 131);
    assert.equal(s.running, 2);
  });

  it('reads only appended bytes and waits for a partial last line', async () => {
    const file = join(fx.sub, 'agent-arun.jsonl');
    const before = only(await c.collect({}), SID).subagents.find((a) => a.id === 'arun')!.tokens!.total;
    // 앞쪽 바이트를 같은 길이의 공백으로 덮어도(크기 그대로) 다시 읽지 않으면 합계가 그대로예요
    const size = readFileSync(file).length;
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.alloc(40, 0x20), 0, 40, 0);
    closeSync(fd);
    const half = assistant('msg_7', U1, [{ type: 'tool_use', id: 't9', name: 'Write', input: { file_path: '/x/y/out.txt', content: 'secret' } }], 10);
    appendFileSync(file, half.slice(0, 30));
    let a = only(await c.collect({}), SID).subagents.find((x) => x.id === 'arun')!;
    assert.equal(a.tokens!.total, before, 'partial line not counted yet');
    assert.equal(a.activity, 'Bash');
    appendFileSync(file, half.slice(30));
    a = only(await c.collect({}), SID).subagents.find((x) => x.id === 'arun')!;
    assert.equal(a.tokens!.total, 115, 'total follows the newest response (its context: 10 + 100 + 5)');
    assert.ok(before === 8 && a.tokens!.output === 2 + 2 + 20, 'per-field counts still add up');
    assert.equal(a.activity, 'Write out.txt');
    assert.ok(readFileSync(file).length > size);
  });

  it('filters by sessionId and sinceMs; meta.finished flips status', async () => {
    assert.deepEqual(await c.collect({ sessionId: SID2 }), []);
    assert.equal((await c.collect({ sessionId: SID })).length, 1);
    writeFileSync(join(fx.sub, 'agent-arun.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Implement widget', finished: true }));
    const s = only(await c.collect({ sessionId: SID }), SID);
    assert.equal(s.subagents.find((a) => a.id === 'arun')!.status, 'done');
    // 아주 짧은 창: 폴더·본 세션 transcript mtime이 창 밖이면 세션째 빠져요
    const past = new Date(Date.now() - 2 * HOUR);
    for (const p of [fx.sub, join(fx.sub, 'workflows'), join(fx.sessionDir, '..', `${SID}.jsonl`)]) utimesSync(p, past, past);
    const fresh = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
    assert.deepEqual(await fresh.collect({ sinceMs: HOUR }), []);
  });

  it('fingerprint changes when a hot file grows or a new subagent appears', async () => {
    const f = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
    await f.collect({});
    const a = await f.fingerprint();
    assert.equal(await f.fingerprint(), a);
    appendFileSync(join(fx.wfDir, 'agent-w3.jsonl'), assistant('m_w3b', U2, [], 10));
    const b = await f.fingerprint();
    assert.notEqual(b, a);
    writeFileSync(join(fx.sub, 'agent-anew.jsonl'), assistant('m_new', U2, [], 10));
    // 폴더 mtime 해상도가 거친 파일시스템도 있어서 폴더 시각을 확실히 바꿔요
    const later = new Date(Date.now() + 5000);
    utimesSync(fx.sub, later, later);
    assert.notEqual(await f.fingerprint(), b);
  });

  it('survives a missing claude dir', async () => {
    const none = createClaudeTaskCollector({ claudeDir: join(t.dir, 'nope') });
    assert.deepEqual(await none.collect({}), []);
    assert.equal(typeof (await none.fingerprint()), 'string');
  });
});

describe('claude tasks — retries, run results, other project dirs, windows, concurrency', () => {
  let t: ReturnType<typeof tempDir>;
  before(() => {
    t = tempDir('m42d-tasks2-');
  });
  after(() => t.cleanup());

  /** 매 테스트 새 픽스처(공유 픽스처를 건드리지 않게) */
  function fresh(name: string): ClaudeFixture & { projDir: string; mainFile: string; runJson: (runId: string, projDir?: string) => string } {
    const fx = buildClaude(join(t.dir, name));
    const projDir = join(fx.claudeDir, 'projects', PROJ);
    return {
      ...fx,
      projDir,
      mainFile: join(projDir, `${SID}.jsonl`),
      runJson: (runId, p = projDir) => join(p, SID, 'workflows', `${runId}.json`),
    };
  }

  function runFile(o: Record<string, unknown>): string {
    // 실제 파일처럼 script·result 본문도 들어 있어요 — 결과에 새면 안 돼요
    return JSON.stringify({ runId: 'x', timestamp: new Date().toISOString(), taskId: 't', script: 'export const meta = {}; secret script body', scriptPath: 'C:\\secret\\s.js', result: { text: 'secret result text' }, logs: [], summary: 'secret summary', defaultModel: 'm', workflowProgress: [], totalToolCalls: 3, ...o });
  }

  it('session cwd prefers the main transcript over a subagent running in a subfolder', async () => {
    const fx = fresh('cwd');
    // 앞의 agent 파일들보다 먼저 읽히는 이름 + 하위 폴더 cwd
    const sub = 'C:\\work\\proj\\.worktrees\\w1';
    writeFileSync(join(fx.sub, 'agent-aaa.jsonl'), line({ type: 'user', timestamp: iso(100), cwd: sub, message: { role: 'user', content: 'x' } }));
    const c = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
    assert.equal(only(await c.collect({}), SID).cwd, normalizePath(CWD));
    // 본 세션 transcript가 없으면 서브에이전트 cwd로
    const fx2 = fresh('cwd2');
    writeFileSync(fx2.mainFile, line({ type: 'ai-title', aiTitle: 'no cwd here' }));
    writeFileSync(join(fx2.sub, 'agent-aaa.jsonl'), line({ type: 'user', timestamp: iso(100), cwd: sub, message: { role: 'user', content: 'x' } }));
    const s2 = only(await createClaudeTaskCollector({ claudeDir: fx2.claudeDir }).collect({}), SID);
    assert.ok([normalizePath(sub), normalizePath(CWD)].includes(s2.cwd));
    assert.notEqual(s2.cwd, '');
  });

  it('a retried key does not resurrect the earlier attempt as an unresolved agent', async () => {
    const fx = fresh('retry');
    const run = 'wf_retry-001';
    const wfDir = join(fx.sub, 'workflows', run);
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'journal.jsonl'),
      // k1: failed 없이 다시 시작 → a2가 끝냄, a1의 늦은 failed는 무시
      line({ type: 'started', key: 'k1', agentId: 'a1', label: 'one', phase: 'P' }) +
        line({ type: 'started', key: 'k1', agentId: 'a2', label: 'one', phase: 'P' }) +
        line({ type: 'failed', key: 'k1', agentId: 'a1' }) +
        line({ type: 'result', key: 'k1', agentId: 'a2', result: { summary: 'ok' } }) +
        // k2: failed 뒤 다시 시작 → b2가 아직 도는 중
        line({ type: 'started', key: 'k2', agentId: 'b1', label: 'two', phase: 'P' }) +
        line({ type: 'failed', key: 'k2', agentId: 'b1' }) +
        line({ type: 'started', key: 'k2', agentId: 'b2', label: 'two', phase: 'P' }),
    );
    for (const id of ['a1', 'a2', 'b1', 'b2']) writeFileSync(join(wfDir, `agent-${id}.jsonl`), assistant(`m_${id}`, U2, [], 500));
    const c = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
    const s = only(await c.collect({}), SID);
    const wf = s.workflows.find((w) => w.runId === run)!;
    assert.deepEqual(wf.agents.map((a) => a.id).sort(), ['a2', 'b2']);
    assert.equal(wf.agents.find((a) => a.id === 'a2')!.status, 'done');
    assert.equal(wf.agents.find((a) => a.id === 'b2')!.status, 'running');
    assert.deepEqual(wf.progress, { done: 1, total: 2 });
    assert.deepEqual(wf.phases, [{ title: 'P', started: 2, done: 1 }]);
    assert.equal(wf.status, 'running');
    // 세션 running = 원래 픽스처(arun + w3) + b2
    assert.equal(s.running, 3);
  });

  it('uses the run result json: completed → done, killed → failed, name/total from it, no bodies leak', async () => {
    const fx = fresh('runjson');
    const c = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
    // 끝나기 전: w3가 도는 중이고, 실행 결과 자리가 서명에 들어 있어요
    let wf = only(await c.collect({}), SID).workflows[0]!;
    assert.equal(wf.status, 'running');
    const fp = await c.fingerprint();
    const start = Date.now() - 60_000;
    writeFileSync(fx.runJson(RUN), runFile({ runId: RUN, status: 'completed', workflowName: 'from-run', agentCount: 4, durationMs: 30_000, startTime: start, totalTokens: 999, phases: [{ title: 'Review' }] }));
    assert.notEqual(await c.fingerprint(), fp, 'run json appearing changes the fingerprint');
    const s = only(await c.collect({}), SID);
    wf = s.workflows[0]!;
    assert.equal(wf.status, 'done');
    assert.equal(wf.agents.find((a) => a.id === 'w3')!.status, 'done');
    assert.ok(wf.agents.find((a) => a.id === 'w3')!.endedAt);
    assert.equal(wf.agents.find((a) => a.id === 'w2')!.status, 'failed', 'journal outcome still wins');
    assert.equal(wf.name, 'demo-review', 'script meta name wins');
    assert.deepEqual(wf.progress, { done: 4, total: 4 });
    assert.equal(wf.startedAt, new Date(start).toISOString());
    assert.equal(s.running, 1, 'only arun is still running');
    const json = JSON.stringify(s);
    for (const secret of ['secret script', 'secret result', 'secret summary', 'C:\\\\secret']) assert.ok(!json.includes(secret), `no "${secret}"`);

    // 스크립트 meta가 없는 실행: 이름·단계는 실행 결과에서, killed면 끝나지 않은 agent는 failed
    const run2 = 'wf_killed-002';
    const wf2Dir = join(fx.sub, 'workflows', run2);
    mkdirSync(wf2Dir, { recursive: true });
    writeFileSync(join(wf2Dir, 'journal.jsonl'), line({ type: 'started', key: 'k1', agentId: 'q1' }) + line({ type: 'started', key: 'k2', agentId: 'q2' }) + line({ type: 'result', key: 'k2', agentId: 'q2' }));
    writeFileSync(join(wf2Dir, 'agent-q1.jsonl'), assistant('m_q1', U2, [], 100));
    writeFileSync(fx.runJson(run2), runFile({ runId: run2, status: 'killed', workflowName: 'killed-one', agentCount: 3, phases: [{ title: 'Only' }] }));
    const k = only(await c.collect({}), SID).workflows.find((w) => w.runId === run2)!;
    assert.equal(k.status, 'failed');
    assert.equal(k.name, 'killed-one');
    assert.equal(k.agents.find((a) => a.id === 'q1')!.status, 'failed');
    assert.deepEqual(k.progress, { done: 2, total: 3 });
    assert.deepEqual(k.phases, [{ title: 'Only', started: 0, done: 0 }]);
  });

  it('finds script meta and run json under a different project dir for the same session', async () => {
    const fx = fresh('otherproj');
    const run = 'wf_moved-003';
    const wfDir = join(fx.sub, 'workflows', run);
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, 'journal.jsonl'), line({ type: 'started', key: 'k1', agentId: 'z1', phase: 'Go' }));
    writeFileSync(join(wfDir, 'agent-z1.jsonl'), assistant('m_z1', U2, [], 100));
    // 세션이 다른 폴더로 cd 한 뒤라 스크립트·결과는 다른 프로젝트 폴더 아래에 있어요
    const other = join(fx.claudeDir, 'projects', 'C--work-proj-sub');
    mkdirSync(join(other, SID, 'workflows', 'scripts'), { recursive: true });
    writeFileSync(join(other, SID, 'workflows', 'scripts', `moved-${run}.js`), "export const meta = { name: 'moved-wf', phases: [{ title: 'Go' }, { title: 'Done' }] }\n");
    const c = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
    let wf = only(await c.collect({}), SID).workflows.find((w) => w.runId === run)!;
    assert.equal(wf.name, 'moved-wf');
    assert.deepEqual(wf.phases.map((p) => p.title), ['Go', 'Done']);
    assert.equal(wf.status, 'running');
    writeFileSync(fx.runJson(run, other), runFile({ runId: run, status: 'completed', workflowName: 'ignored', agentCount: 1 }));
    wf = only(await c.collect({}), SID).workflows.find((w) => w.runId === run)!;
    assert.equal(wf.status, 'done');
    assert.equal(wf.name, 'moved-wf');
    // 다른 프로젝트 폴더에는 subagents가 없어서 세션은 하나로만 나와요
    assert.equal((await c.collect({})).filter((s) => s.sessionId === SID).length, 1);
  });

  it('keeps a session whose subagent folders are old but whose main transcript is fresh (daemon restart)', async () => {
    const fx = fresh('mainmtime');
    const past = new Date(Date.now() - 2 * HOUR);
    for (const p of [fx.sub, join(fx.sub, 'workflows')]) utimesSync(p, past, past);
    // 새로 띄운 데몬(빈 hot 목록): 오래전에 만든 agent 파일이 지금도 자라요
    const c = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
    const s = only(await c.collect({ sinceMs: HOUR }), SID);
    assert.equal(s.subagents.find((a) => a.id === 'arun')!.status, 'running');
    // 서명도 본 세션 transcript 시각을 따라가요
    const a = await c.fingerprint();
    const later = new Date(Date.now() + 5000);
    utimesSync(fx.mainFile, later, later);
    assert.notEqual(await c.fingerprint(), a);
  });

  it('runs collection passes one at a time and shares a queued pass with the same options', async () => {
    const fx = fresh('single');
    let active = 0;
    let maxActive = 0;
    const reader: typeof readAppended = async (file, cur, size, on) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((r) => setTimeout(r, 5));
        await readAppended(file, cur, size, on);
      } finally {
        active--;
      }
    };
    const c = createClaudeTaskCollector({ claudeDir: fx.claudeDir, readAppended: reader });
    const p1 = c.collect({});
    const p2 = c.collect({ sessionId: SID });
    const p3 = c.collect({ sessionId: SID });
    assert.equal(p2, p3, 'same options while queued → same pass');
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(maxActive, 1);
    assert.equal(only(a, SID).tokens.total, only(b, SID).tokens.total);
  });

  it('retries a file whose read failed (EBUSY) instead of marking it read', async () => {
    const fx = fresh('ebusy');
    let fail = true;
    const reader: typeof readAppended = async (file, cur, size, on) => {
      if (fail && (file.endsWith('agent-arun.jsonl') || file.endsWith('journal.jsonl'))) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      await readAppended(file, cur, size, on);
    };
    const c = createClaudeTaskCollector({ claudeDir: fx.claudeDir, readAppended: reader });
    let s = only(await c.collect({}), SID);
    let run = s.subagents.find((a) => a.id === 'arun')!;
    assert.equal(run.tokens, undefined, 'nothing read yet');
    assert.equal(run.status, 'running', 'status still from the file stat');
    assert.ok(Date.parse(run.updatedAt) > Date.now() - HOUR);
    assert.equal(s.workflows[0]!.agents.find((a) => a.id === 'w1')!.label, 'review runtime', 'journal not read yet');
    fail = false;
    s = only(await c.collect({}), SID);
    run = s.subagents.find((a) => a.id === 'arun')!;
    assert.equal(run.tokens!.total, 8);
    assert.equal(run.activity, 'Bash');
    assert.equal(s.workflows[0]!.agents.find((a) => a.id === 'w1')!.label, 'review:runtime');
  });

  it('evicts cached file state not touched in the last two full passes, but not on filtered passes', async () => {
    const fx = fresh('evict');
    const c = createClaudeTaskCollector({ claudeDir: fx.claudeDir });
    await c.collect({});
    const n = c.cachedFiles;
    assert.ok(n > 0);
    // 세션 필터 패스는 다른 캐시를 버리지 않아요
    await c.collect({ sessionId: SID2 });
    await c.collect({ sessionId: SID2 });
    await c.collect({ sessionId: SID2 });
    assert.equal(c.cachedFiles, n);
    // 창을 아주 좁히면 파일이 창 밖 — 전체 패스 두 번 뒤에 버려요
    await c.collect({ sinceMs: 1 });
    assert.equal(c.cachedFiles, n, 'kept after one pass');
    await c.collect({ sinceMs: 1 });
    assert.equal(c.cachedFiles, 0);
  });
});

describe('workflow script meta (never executed)', () => {
  it('extracts name/description/phase titles tolerantly', () => {
    const m = parseWorkflowScriptMeta(
      "// header\nexport const meta = {\n  description: \"multi \\\"quoted\\\"\",\n  name: `tpl-name`,\n  phases: [\n    { title: 'A [x]', detail: '{ brace' },\n    { title: 'B' },\n  ],\n};\n",
    );
    assert.deepEqual(m, { name: 'tpl-name', description: 'multi "quoted"', phases: ['A [x]', 'B'] });
    assert.equal(parseWorkflowScriptMeta('const x = 1;'), null);
    assert.deepEqual(parseWorkflowScriptMeta("export const meta = { name: 'only' }"), { name: 'only', phases: [] });
    // 잘린 파일(앞부분만)도 버텨요
    assert.deepEqual(parseWorkflowScriptMeta("export const meta = { name: 'cut', phases: [{ title: 'P1' }, { tit"), { name: 'cut', phases: ['P1'] });
  });

  it('toolActivity keeps only the tool name and a file basename', () => {
    assert.equal(toolActivity('Bash', { command: 'echo secret' }), 'Bash');
    assert.equal(toolActivity('Read', { file_path: 'C:\\a\\b\\c.ts' }), 'Read c.ts');
    assert.equal(toolActivity('NotebookEdit', { notebook_path: '/n/book.ipynb' }), 'NotebookEdit book.ipynb');
    assert.equal(toolActivity('Glob', { pattern: '**/*.key' }), 'Glob');
  });
});

describe('readAppended', () => {
  it('skips over-long and malformed lines, keeps partial tail for later', async () => {
    const t = tempDir('m42d-tasks-ra-');
    try {
      const f = join(t.dir, 'x.jsonl');
      writeFileSync(f, '{"a":1}\nnope\n{"b":2}\n{"c":');
      const got: unknown[] = [];
      const cur = newCursor();
      const push = (r: unknown): void => {
        got.push(r);
      };
      await readAppended(f, cur, readFileSync(f).length, push);
      assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
      appendFileSync(f, '3}\n');
      await readAppended(f, cur, readFileSync(f).length, push);
      assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
      // 긴 줄: 작은 청크로 여러 번에 걸쳐 들어와도 건너뛰고, 다음 호출에서 다시 읽지 않아요
      const prev = { ...TASKS_TUNING };
      TASKS_TUNING.maxLineBytes = 64;
      TASKS_TUNING.chunkBytes = 16;
      try {
        appendFileSync(f, `{"long":"${'z'.repeat(200)}`);
        await readAppended(f, cur, readFileSync(f).length, push);
        assert.equal(cur.skipping, true);
        assert.equal(cur.offset, readFileSync(f).length);
        appendFileSync(f, `${'z'.repeat(50)}"}\n{"d":4}\n`);
        await readAppended(f, cur, readFileSync(f).length, push);
        assert.deepEqual(got.slice(3), [{ d: 4 }]);
      } finally {
        Object.assign(TASKS_TUNING, prev);
      }
    } finally {
      t.cleanup();
    }
  });
});

// ---- Codex

const P1 = '01a20000-0000-7000-8000-000000000001';
const C_DONE = '01a20000-0000-7000-8000-000000000002';
const C_RUN = '01a20000-0000-7000-8000-000000000003';
const C_ABORT = '01a20000-0000-7000-8000-000000000004';
const C_OLD = '01a20000-0000-7000-8000-000000000005';
const C_SRC = '01a20000-0000-7000-8000-000000000006';
const P2 = '01a20000-0000-7000-8000-000000000007';

function ev(type: string): string {
  return line({ type: 'event_msg', timestamp: iso(1000), payload: { type } });
}

function buildCodex(root: string): { home: string; db: string; rollout: (id: string) => string } {
  const home = join(root, 'codex');
  const sessions = join(home, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const rollout = (id: string) => join(sessions, `rollout-${id}.jsonl`);
  const db = join(home, 'state_5.sqlite');
  const d = new DatabaseSync(db);
  d.exec('PRAGMA journal_mode=WAL');
  d.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER, updated_at INTEGER, source TEXT NOT NULL,
    cwd TEXT NOT NULL, title TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0, agent_nickname TEXT, agent_role TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER, name TEXT)`);
  d.exec('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)');
  const ins = d.prepare('INSERT INTO threads (id, rollout_path, source, cwd, title, tokens_used, agent_nickname, agent_role, created_at_ms, updated_at_ms, name) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const now = Date.now();
  ins.run(P1, rollout(P1), 'vscode', '\\\\?\\C:\\work\\proj', 'Parent thread', 900, null, null, now - 2 * HOUR, now - 1000, null);
  ins.run(P2, rollout(P2), 'vscode', 'C:\\other', 'Other parent', 0, null, null, now - 30 * HOUR, now - 30 * HOUR, null);
  ins.run(C_DONE, rollout(C_DONE), 'vscode', 'C:\\work\\proj', 'review the diff', 1200, 'Kepler', 'reviewer', now - HOUR, now - 50 * 60 * 1000, null);
  ins.run(C_RUN, rollout(C_RUN), 'vscode', 'C:\\work\\proj', '', 300, 'Hubble', null, now - 10 * 60 * 1000, now - 5000, null);
  ins.run(C_ABORT, rollout(C_ABORT), 'vscode', 'C:\\work\\proj', 'x', 50, null, 'worker', now - HOUR, now - HOUR, null);
  ins.run(C_OLD, rollout(C_OLD), 'vscode', 'C:\\other', 'old', 10, 'Old', null, now - 30 * HOUR, now - 30 * HOUR, null);
  // 간선 없이 source JSON으로만 부모를 아는 하위 스레드
  ins.run(C_SRC, rollout(C_SRC), JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: P1 } } }), 'C:\\work\\proj', 'src child', 7, 'Src', null, now - 1000, now - 1000, null);
  const edge = d.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')");
  edge.run(P1, C_DONE);
  edge.run(P1, C_RUN);
  edge.run(P1, C_ABORT);
  edge.run(P2, C_OLD);
  d.close();

  writeFileSync(rollout(C_DONE), ev('task_started') + line({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat /etc/secret"}' } }) + ev('task_complete'));
  writeFileSync(rollout(C_RUN), ev('task_complete') + ev('task_started') + line({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** secret patch' } }) + '{"partial":');
  writeFileSync(rollout(C_ABORT), ev('task_started') + ev('turn_aborted'));
  writeFileSync(rollout(C_SRC), ev('task_started'));
  for (const id of [C_DONE, C_ABORT]) setOld(rollout(id), HOUR);
  return { home, db, rollout };
}

describe('codex tasks', () => {
  let t: ReturnType<typeof tempDir>;
  let cx: ReturnType<typeof buildCodex>;
  before(() => {
    t = tempDir('m42d-tasks-cx-');
    cx = buildCodex(t.dir);
  });
  after(() => t.cleanup());

  it('groups spawned children under the parent thread with status from rollout events', async () => {
    const c = createCodexTaskCollector({ codexHome: cx.home });
    const list = await c.collect({});
    assert.equal(list.length, 1, 'P2 child is outside sinceMs');
    const s = list[0]!;
    assert.equal(s.agent, 'codex');
    assert.equal(s.sessionId, P1);
    assert.equal(s.title, 'Parent thread');
    assert.equal(s.cwd, normalizePath('C:\\work\\proj'));
    assert.deepEqual(s.workflows, []);
    const by = new Map(s.subagents.map((a) => [a.id, a]));
    assert.equal(by.get(C_DONE)!.status, 'done');
    assert.equal(by.get(C_DONE)!.label, 'Kepler · review the diff');
    assert.equal(by.get(C_DONE)!.kind, 'reviewer');
    assert.equal(by.get(C_DONE)!.activity, 'exec_command');
    assert.deepEqual(by.get(C_DONE)!.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 1200 });
    assert.equal(by.get(C_RUN)!.status, 'running');
    assert.equal(by.get(C_RUN)!.label, 'Hubble');
    assert.equal(by.get(C_RUN)!.activity, 'apply_patch');
    assert.equal(by.get(C_ABORT)!.status, 'failed');
    assert.equal(by.get(C_SRC)!.status, 'running');
    assert.equal(s.running, 2);
    assert.equal(s.tokens.total, 1200 + 300 + 50 + 7);
    assert.equal(s.subagents[0]!.status, 'running');
    const json = JSON.stringify(list);
    assert.ok(!json.includes('secret'));
    // 넓은 창이면 P2도
    const wide = await c.collect({ sinceMs: 48 * HOUR });
    assert.equal(wide.length, 2);
    assert.equal(wide.find((x) => x.sessionId === P2)!.subagents[0]!.status, 'stale');
    assert.deepEqual((await c.collect({ sessionId: P2 })).length, 0);
  });

  it('fingerprint follows the db and hot rollouts; missing db is empty', async () => {
    const c = createCodexTaskCollector({ codexHome: cx.home });
    await c.collect({});
    const a = await c.fingerprint();
    appendFileSync(cx.rollout(C_RUN), '"x"}\n');
    assert.notEqual(await c.fingerprint(), a);
    const none = createCodexTaskCollector({ codexHome: join(t.dir, 'nope') });
    assert.deepEqual(await none.collect({}), []);
    assert.equal(typeof (await none.fingerprint()), 'string');
  });
});

describe('codex tasks — nested spawns, cutoff before tail reads, cache bounds', () => {
  const G1 = '01a20000-0000-7000-8000-0000000000a1';
  const G2 = '01a20000-0000-7000-8000-0000000000a2';
  const X1 = '01a20000-0000-7000-8000-0000000000b1';
  const X2 = '01a20000-0000-7000-8000-0000000000b2';

  it('rootThread walks parent links to the top and stops on cycles deterministically', () => {
    const parentOf = new Map([
      ['c', 'b'],
      ['b', 'a'],
      ['x', 'y'],
      ['y', 'x'],
      ['t', 'x'],
    ]);
    assert.equal(rootThread('c', parentOf), 'a');
    assert.equal(rootThread('a', parentOf), 'a');
    assert.equal(rootThread('x', parentOf), 'x');
    assert.equal(rootThread('y', parentOf), 'x');
    assert.equal(rootThread('t', parentOf), 'x');
  });

  it('groups depth-2+ spawns under the root session and survives parent cycles', async () => {
    const t = tempDir('m42d-tasks-cx2-');
    try {
      const cx = buildCodex(t.dir);
      const d = new DatabaseSync(cx.db);
      const now = Date.now();
      const ins = d.prepare('INSERT INTO threads (id, rollout_path, source, cwd, title, tokens_used, agent_nickname, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)');
      // C_RUN이 낳은 손주(간선) + 그 손주가 낳은 증손주(source JSON만)
      ins.run(G1, cx.rollout(G1), 'vscode', 'C:\\work\\proj\\deep', 'grandchild', 5, 'Gauss', now - 1000, now - 1000);
      ins.run(G2, cx.rollout(G2), JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: G1 } } }), 'C:\\work\\proj\\deeper', 'great', 3, 'Euler', now - 1000, now - 1000);
      // 서로를 부모로 가리키는 고리
      ins.run(X1, cx.rollout(X1), 'vscode', 'C:\\loop', 'loop a', 1, null, now - 1000, now - 1000);
      ins.run(X2, cx.rollout(X2), 'vscode', 'C:\\loop', 'loop b', 1, null, now - 1000, now - 1000);
      const edge = d.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')");
      edge.run(C_RUN, G1);
      edge.run(X1, X2);
      edge.run(X2, X1);
      d.close();
      for (const id of [G1, G2]) writeFileSync(cx.rollout(id), ev('task_started'));

      const c = createCodexTaskCollector({ codexHome: cx.home });
      const list = await c.collect({});
      assert.ok(!list.some((s) => s.sessionId === C_RUN || s.sessionId === G1), 'no session per intermediate thread');
      const s = list.find((x) => x.sessionId === P1)!;
      const ids = s.subagents.map((a) => a.id);
      assert.ok(ids.includes(G1) && ids.includes(G2));
      assert.equal(s.cwd, normalizePath('C:\\work\\proj'), 'root thread cwd');
      assert.equal(s.running, 4);
      const loop = list.find((x) => x.sessionId === X1)!;
      assert.deepEqual(loop.subagents.map((a) => a.id).sort(), [X1, X2]);
      // 세션 필터도 맨 위 세션 id로
      const f = await c.collect({ sessionId: P1 });
      assert.equal(f.length, 1);
      assert.ok(f[0]!.subagents.some((a) => a.id === G2));
      assert.deepEqual(await c.collect({ sessionId: G1 }), []);
    } finally {
      t.cleanup();
    }
  });

  it('skips rollout tail reads for children outside the window and evicts the rollout cache', async () => {
    const t = tempDir('m42d-tasks-cx3-');
    try {
      const cx = buildCodex(t.dir);
      // DB 시각은 30시간 전인데 rollout 파일만 새로 — 창 밖이라 꼬리를 읽지 않아요
      writeFileSync(cx.rollout(C_OLD), ev('task_started'));
      const c = createCodexTaskCollector({ codexHome: cx.home });
      const list = await c.collect({});
      assert.ok(!list.some((s) => s.subagents.some((a) => a.id === C_OLD)));
      assert.equal(c.cachedRollouts, 4, 'C_DONE, C_RUN, C_ABORT, C_SRC only');
      await c.collect({ sinceMs: 48 * HOUR });
      assert.equal(c.cachedRollouts, 5);
      // 세션 필터 패스는 버리지 않고, 전체 패스 두 번 동안 안 쓰인 건 버려요
      await c.collect({ sessionId: P1 });
      assert.equal(c.cachedRollouts, 5);
      await c.collect({});
      assert.equal(c.cachedRollouts, 5, 'kept after one pass');
      await c.collect({});
      assert.equal(c.cachedRollouts, 4);
    } finally {
      t.cleanup();
    }
  });
});

// ---- 모니터

describe('task monitor', () => {
  it('merges, sorts running-first, limits and filters by agent', async () => {
    const t = tempDir('m42d-tasks-mon-');
    try {
      const fx = buildClaude(t.dir);
      const cx = buildCodex(t.dir);
      const m = createTaskMonitor({ claudeDir: fx.claudeDir, codexHome: cx.home });
      const all = await m.list({});
      assert.deepEqual(all.map((s) => s.agent).sort(), ['claude', 'codex']);
      assert.ok(all.every((s) => s.running > 0));
      assert.ok(all[0]!.updatedAt >= all[1]!.updatedAt);
      assert.equal((await m.list({ limit: 1 })).length, 1);
      assert.deepEqual((await m.list({ agent: 'codex' })).map((s) => s.sessionId), [P1]);
      assert.deepEqual((await m.list({ agent: 'claude', sessionId: SID })).map((s) => s.sessionId), [SID]);
    } finally {
      t.cleanup();
    }
  });

  it('calls onChange when the fingerprint changes and stops cleanly', async () => {
    const t = tempDir('m42d-tasks-mon2-');
    try {
      const fx = buildClaude(t.dir);
      const m = createTaskMonitor({ claudeDir: fx.claudeDir, codexHome: join(t.dir, 'no-codex'), pollMs: 30 });
      let changes = 0;
      m.start(() => changes++);
      // 기준값이 잡힐 때까지
      await new Promise((r) => setTimeout(r, 150));
      const base = changes;
      appendFileSync(join(fx.sub, 'agent-arun.jsonl'), assistant('m_more', U2, [], 10));
      await until(() => changes > base, 3000, 'onChange after append');
      m.stop();
      const stoppedAt = changes;
      appendFileSync(join(fx.sub, 'agent-arun.jsonl'), assistant('m_more2', U2, [], 10));
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(changes, stoppedAt);
    } finally {
      t.cleanup();
    }
  });
});
