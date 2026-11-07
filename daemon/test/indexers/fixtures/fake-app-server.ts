// 가짜 `codex app-server` (stdio, "jsonrpc" 필드 없는 줄 단위 JSON). 테스트에서 node로 실행해요.
// 환경 변수: FAKE_MODE(normal|hang|crash|error), FAKE_THREADS(JSON 파일), FAKE_LOADED(쉼표 구분 id), FAKE_LOG(받은 메서드 기록 파일)
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MODE ?? 'normal';
const logFile = process.env.FAKE_LOG;
const record = (line: string) => {
  if (logFile) appendFileSync(logFile, line + '\n');
};
record(`pid ${process.pid} argv ${process.argv.slice(2).join(' ')} home ${process.env.CODEX_HOME ?? ''}`);

if (mode === 'crash') process.exit(3);

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown> };
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
const threads = (): Record<string, unknown>[] => (process.env.FAKE_THREADS ? JSON.parse(readFileSync(process.env.FAKE_THREADS, 'utf8')) : []);
const norm = (p: string) => p.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase();
const kindOf = (src: unknown): string => {
  if (typeof src === 'string') return src;
  const sub = (src as { subAgent?: unknown }).subAgent;
  if (sub && typeof sub === 'object' && 'thread_spawn' in sub) return 'subAgentThreadSpawn';
  if (sub && typeof sub === 'object' && 'other' in sub) return 'subAgentOther';
  return 'subAgent';
};
let initialized = false;

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line) as Msg;
  record(`${m.method ?? 'response'} ${JSON.stringify(m.params ?? {})}`);
  if ('jsonrpc' in m) record('UNEXPECTED jsonrpc field');
  if (m.method === 'initialized') {
    initialized = true;
    // 서버 요청 하나 — 클라이언트는 거절해야 해요
    send({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: {} });
    return;
  }
  if (m.id === undefined) return;
  if (mode === 'hang') return;
  switch (m.method) {
    case 'initialize':
      send({ id: m.id, result: { userAgent: 'fake/0', codexHome: process.env.CODEX_HOME ?? '', platformFamily: 'windows', platformOs: 'windows' } });
      send({ method: 'remoteControl/status/changed', params: {} });
      return;
    case 'thread/list': {
      const p = m.params ?? {};
      if (!initialized) return send({ id: m.id, error: { code: -32600, message: 'not initialized' } });
      if (mode === 'error') return send({ id: m.id, error: { code: -32603, message: 'boom' } });
      if (p.useStateDbOnly !== true) return send({ id: m.id, error: { code: -32602, message: 'test requires useStateDbOnly' } });
      const kinds = Array.isArray(p.sourceKinds) ? (p.sourceKinds as string[]) : ['cli', 'vscode', 'appServer'];
      let rows = threads().filter((t) => kinds.includes(kindOf(t.source)));
      if (typeof p.cwd === 'string') rows = rows.filter((t) => norm(String(t.cwd)) === norm(p.cwd as string));
      rows.sort((a, b) => Number(b.recencyAt) - Number(a.recencyAt));
      const start = typeof p.cursor === 'string' ? Number(p.cursor) : 0;
      const limit = typeof p.limit === 'number' ? p.limit : 50;
      const page = rows.slice(start, start + limit);
      const next = start + limit < rows.length ? String(start + limit) : null;
      return send({ id: m.id, result: { data: page, nextCursor: next, backwardsCursor: null } });
    }
    case 'thread/loaded/list':
      return send({ id: m.id, result: { data: (process.env.FAKE_LOADED ?? '').split(',').filter(Boolean), nextCursor: null } });
    default:
      return send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
});
rl.on('close', () => {
  record('stdin closed');
  process.exit(0);
});
