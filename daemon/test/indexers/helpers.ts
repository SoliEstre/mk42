// 테스트 공용: 임시 폴더·합성 픽스처. 실제 ~/.claude·~/.codex는 건드리지 않아요.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function makeTmp(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `m42-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

export function jsonl(recs: unknown[]): string {
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** 끝난 프로세스의 pid (죽은 pid 픽스처) */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export interface FakeThreadRow {
  id: string;
  cwd: string;
  title?: string;
  name?: string | null;
  preview?: string;
  source?: string;
  thread_source?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  archived?: number;
  recency_at_ms: number;
}

/** 실측한 state_5.sqlite threads 열 구성(2026-10-17, 마이그레이션 59)을 본뜬 합성 DB */
export function makeCodexStateDb(path: string, rows: FakeThreadRow[], edges: { parent: string; child: string }[] = []): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER,
    git_sha TEXT, git_branch TEXT, git_origin_url TEXT, cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT,
    memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, agent_path TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '',
    recency_at INTEGER NOT NULL, recency_at_ms INTEGER NOT NULL, history_mode TEXT NOT NULL DEFAULT 'paginated',
    name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)');
  const ins = db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
    sandbox_policy, approval_mode, archived, model, reasoning_effort, created_at_ms, updated_at_ms, thread_source, preview,
    recency_at, recency_at_ms, name) VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, '{"type":"disabled"}', 'never', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    const sec = Math.floor(r.recency_at_ms / 1000);
    ins.run(
      r.id,
      `C:\\fake\\rollout-${r.id}.jsonl`,
      sec,
      sec,
      r.source ?? 'vscode',
      r.cwd,
      r.title ?? r.preview ?? '',
      r.archived ?? 0,
      r.model ?? null,
      r.reasoning_effort ?? null,
      r.recency_at_ms,
      r.recency_at_ms,
      r.thread_source === undefined ? 'user' : r.thread_source,
      r.preview ?? '',
      sec,
      r.recency_at_ms,
      r.name === undefined ? null : r.name,
    );
  }
  const e = db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')");
  for (const x of edges) e.run(x.parent, x.child);
  db.close();
}
