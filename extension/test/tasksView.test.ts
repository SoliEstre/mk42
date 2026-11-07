import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import type { AgentKind, SessionTasks } from '@mark42/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(join(here, 'helpers', 'vscode-stub.ts')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true, format: 'module' };
    return next(specifier, context);
  },
});
const vs = (await import(stubUrl)) as typeof import('./helpers/vscode-stub.ts');
const { TasksMonitor, TASKS_VIEW_IDS, AGENT_KIND_CONTEXT, FIT_HEIGHT_COMMAND, renderTasksHtml, renderTasksBody } =(await import('../src/tasksView.ts')) as typeof import('../src/tasksView.ts');

const silent = { info() {}, warn() {}, error() {}, debug() {}, show() {} };
const SID = '0b6c4f7e-1111-2222-3333-444455556666';
const NOW = Date.parse('2026-10-30T10:10:00Z');
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function tasksFor(sessionId: string, running = 2): SessionTasks {
  const tokens = { input: 1000, output: 2000, cacheRead: 400_000, cacheCreation: 9_345, total: 412_345 };
  return {
    agent: 'claude',
    sessionId,
    cwd: 'c:\\dev\\proj',
    workflows: [
      {
        runId: 'wf_1',
        name: 'review <script>',
        phases: [
          { title: '탐색', started: 2, done: 2 },
          { title: '구현', started: 3, done: 1 },
          { title: '검증', started: 0, done: 0 },
        ],
        agents: [
          { id: 'a1', label: 'lane A', kind: 'general-purpose', phase: '구현', status: running ? 'running' : 'done', startedAt: '2026-10-30T10:03:29Z', updatedAt: '2026-10-30T10:09:00Z', activity: 'Edit tasksView.ts' },
          { id: 'a2', label: '<img src=x onerror=alert(1)>', phase: '탐색', status: 'done', startedAt: '2026-10-30T10:00:00Z', endedAt: '2026-10-30T10:00:35Z', updatedAt: '2026-10-30T10:00:35Z' },
        ],
        status: running ? 'running' : 'done',
        startedAt: '2026-10-30T10:00:00Z',
        updatedAt: '2026-10-30T10:09:00Z',
        progress: { done: 3, total: 5 },
        tokens,
      },
    ],
    subagents: [{ id: 's1', label: 'Explore docs', kind: 'Explore', status: 'failed', updatedAt: '2026-10-30T10:08:00Z', summary: 'did "x" & y' }],
    running,
    tokens,
    updatedAt: '2026-10-30T10:09:00Z',
  };
}

function fakeDaemon(reply: (params: any) => unknown) {
  const calls: any[] = [];
  const stateListeners = new Set<(s: string) => void>();
  const d = {
    state: 'connected' as string,
    connected: true,
    calls,
    get api() {
      return d.connected
        ? {
            request: async (method: string, params: unknown) => {
              calls.push([method, params]);
              return reply(params);
            },
          }
        : undefined;
    },
    onStateChange(cb: (s: string) => void) {
      stateListeners.add(cb);
      return { dispose: () => stateListeners.delete(cb) };
    },
    setState(s: string) {
      d.state = s;
      d.connected = s === 'connected';
      for (const l of stateListeners) l(s);
    },
  };
  return d;
}

function monitor(o: { agent?: AgentKind; session?: () => string | undefined; reply?: (p: any) => unknown }) {
  vs.reset();
  const daemon = fakeDaemon(o.reply ?? ((p) => [tasksFor(p.sessionId)]));
  const m = new TasksMonitor({
    daemon: daemon as never,
    log: silent,
    agent: () => o.agent,
    sessionId: o.session ?? (() => SID),
    now: () => NOW,
  });
  const status = vs.state.statusItems.find((s) => s.id === 'mark42.tasks.status')!;
  return { m, daemon, status };
}
const ctx = () => vs.state.executed.filter((e) => e.id === 'setContext' && e.args[0] === AGENT_KIND_CONTEXT).map((e) => e.args[1]);

test('tasks: both agent views get a provider; agent window sets the agent kind; data drives status bar, badge, description', async () => {
  const { m, daemon, status } = monitor({ agent: 'claude' });
  try {
    assert.ok(vs.state.webviewViewProviders.has(TASKS_VIEW_IDS.claude) && vs.state.webviewViewProviders.has(TASKS_VIEW_IDS.codex));
    assert.deepEqual(ctx(), ['claude']);
    const view = vs.createWebviewView(TASKS_VIEW_IDS.claude);
    m.resolveWebviewView(view as never);
    assert.deepEqual(view.webview.options, { enableScripts: true, enableCommandUris: false, localResourceRoots: [] });
    await settle();
    assert.deepEqual(daemon.calls, [['tasks.list', { sessionId: SID, agent: 'claude' }]], 'constructor + resolve coalesce into one load');
    assert.equal(status.visible, true);
    assert.equal(status.text, '$(sync~spin) 2 · 412k');
    assert.equal(status.command, 'mark42.tasks.claude.focus');
    assert.deepEqual(view.badge, { value: 2, tooltip: '2 실행 중' });
    assert.equal(view.description, '2 실행 중 · 412k');
    const html = view.webview.html;
    assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-([A-Za-z0-9+/=]+)';/);
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(html)![1];
    assert.equal((html.match(/<script/gi) ?? []).length, 1, 'only the one nonce script — names are escaped');
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.match(html, /review &lt;script&gt;/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /<li class="cur"[^>]*>구현<span class="n">1\/3<\/span>/, 'current phase highlighted');
    assert.match(html, /<li class="done"[^>]*>탐색/);
    assert.match(html, /width:60%/);
    assert.match(html, /6분 31초/, 'running agent counts to now');
    assert.match(html, /35초/);
    assert.match(html, /Edit tasksView.ts/);
    assert.match(html, /title="did &quot;x&quot; &amp; y"/);
    assert.match(html, /실패/);
  } finally {
    m.dispose();
  }
});

test('tasks: nothing running hides the status item and badge; empty session and no session show a message', async () => {
  let session: string | undefined;
  const { m, daemon, status } = monitor({ agent: 'codex', session: () => session, reply: (p) => (p.sessionId === 'empty' ? [{ ...tasksFor('empty', 0), workflows: [], subagents: [] }] : [tasksFor(p.sessionId, 0)]) });
  try {
    const view = vs.createWebviewView(TASKS_VIEW_IDS.codex);
    m.resolveWebviewView(view as never);
    await settle();
    assert.equal(daemon.calls.length, 0, 'no bound session: nothing to ask');
    assert.match(view.webview.html, /이 창에 열린 세션이 아직 없어요/);
    session = 'idle';
    await m.reload();
    assert.deepEqual(daemon.calls.at(-1), ['tasks.list', { sessionId: 'idle', agent: 'codex' }]);
    assert.equal(status.visible, false);
    assert.equal(view.badge, undefined);
    assert.equal(view.description, '412k');
    assert.match(view.webview.html, /완료/);
    session = 'empty';
    await m.reload();
    assert.match(view.webview.html, /백그라운드 작업이 없어요/);
    assert.equal(view.description, '412k');
  } finally {
    m.dispose();
  }
});

test('tasks: a session change drops the old data; a reply for the old session is not shown', async () => {
  let session = 'one';
  let release: () => void = () => {};
  const { m, daemon } = monitor({
    agent: 'claude',
    session: () => session,
    reply: async (p) => {
      if (p.sessionId === 'one' && daemon.calls.length > 1) await new Promise<void>((r) => (release = r));
      return [tasksFor(p.sessionId, p.sessionId === 'one' ? 2 : 0)];
    },
  });
  try {
    await settle();
    assert.equal(m.totals.running, 2);
    const slow = m.reload(); // 'one' again, held
    await settle();
    session = 'two';
    release();
    await slow;
    assert.equal(m.totals.running, 0, 'old reply discarded');
    await settle(1100); // throttled retry for the new session
    assert.deepEqual(daemon.calls.at(-1), ['tasks.list', { sessionId: 'two', agent: 'claude' }]);
    assert.equal(m.totals.running, 0);
    assert.equal(m.totals.tokens, 412_345);
  } finally {
    m.dispose();
  }
});

test('tasks: refresh bursts are throttled to one load per second', async () => {
  const { m, daemon } = monitor({ agent: 'claude' });
  try {
    await settle();
    assert.equal(daemon.calls.length, 1);
    for (let i = 0; i < 5; i++) m.refresh();
    await settle(300);
    assert.equal(daemon.calls.length, 1, 'still inside the window');
    await settle(900);
    assert.equal(daemon.calls.length, 2);
  } finally {
    m.dispose();
  }
});

test('tasks: hidden views are not rewritten until shown; disconnect and load errors show a message and stop the spinner', async () => {
  let fail = false;
  const { m, daemon, status } = monitor({
    agent: 'claude',
    reply: (p) => {
      if (fail) throw new Error('boom');
      return [tasksFor(p.sessionId)];
    },
  });
  try {
    const view = vs.createWebviewView(TASKS_VIEW_IDS.claude, false);
    m.resolveWebviewView(view as never);
    await settle();
    assert.equal(view.writes, 0, 'hidden: no html yet');
    assert.deepEqual(view.badge, { value: 2, tooltip: '2 실행 중' }, 'badge still set while collapsed');
    view.setVisible(true);
    assert.equal(view.writes, 1);
    await m.reload();
    assert.equal(view.writes, 1, 'same content is not rewritten');
    assert.equal(view.webview.posted.length, 0, 'nor posted');
    view.setVisible(false);
    view.setVisible(true);
    assert.equal(view.writes, 2, 'shown again: the webview was discarded, so the document is written again');

    daemon.setState('disconnected');
    await settle();
    assert.equal(status.visible, false);
    assert.match(view.webview.html, /데몬에 연결되지 않았어요/);

    daemon.setState('connected');
    fail = true;
    await settle(1100);
    assert.match(view.webview.html, /작업 목록을 불러오지 못했어요/);
    assert.equal(status.visible, false);
  } finally {
    m.dispose();
  }
});

// ---- 웹뷰 스크립트 — 아주 작은 가짜 DOM에서 돌려 봐요(본문 파싱·details·포커스·선택·이벤트만)

type Listener = (e: any) => void;
class FakeEl {
  tagName: string;
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  open = false;
  #doc: FakeDoc;
  constructor(doc: FakeDoc, tag: string) {
    this.#doc = doc;
    this.tagName = tag.toUpperCase();
  }
  get firstElementChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  getBoundingClientRect(): { bottom: number } {
    return { bottom: 20 * (this.#doc.body.children.indexOf(this) + 1) };
  }
  closest(sel: string): FakeEl | null {
    for (let e: FakeEl | null = this; e; e = e.parentElement) if (e.tagName === sel.toUpperCase()) return e;
    return null;
  }
  contains(n: unknown): boolean {
    for (let e = n as FakeEl | null; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  focus(): void {
    this.#doc.activeElement = this;
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
class FakeDoc {
  activeElement: FakeEl | null = null;
  body: FakeEl & { innerHTML: string };
  listeners = new Map<string, Listener[]>();
  constructor() {
    const body = new FakeEl(this, 'body') as FakeEl & { innerHTML: string };
    Object.defineProperty(body, 'innerHTML', { set: (html: string) => this.#parse(html) });
    this.body = body;
    this.activeElement = body;
  }
  #parse(html: string): void {
    this.body.children = [];
    const stack: FakeEl[] = [this.body];
    const created: FakeEl[] = [];
    for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
      if (m[2] === 'script') break; // 스크립트 태그는 다시 돌지 않아요
      if (m[1]) {
        stack.pop();
        continue;
      }
      const el = new FakeEl(this, m[2]!);
      for (const a of m[3]!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        if (a[1]!.startsWith('data-')) el.dataset[a[1]!.slice(5).replace(/-(\w)/g, (_x, c: string) => c.toUpperCase())] = unescape(a[2] ?? '');
        if (a[1] === 'open') el.open = true;
      }
      el.parentElement = stack.at(-1)!;
      stack.at(-1)!.children.push(el);
      stack.push(el);
      created.push(el);
    }
    if (this.activeElement !== this.body && !this.body.contains(this.activeElement)) this.activeElement = this.body;
    // 크로뮴은 열린 채 만들어진 details에도 toggle을 쏴요 — 옛 스크립트가 이걸 사용자 선택으로 잘못 기억했어요
    for (const el of created) if (el.tagName === 'DETAILS' && el.open) setTimeout(() => this.fire('toggle', { target: el }));
  }
  querySelectorAll(sel: string): FakeEl[] {
    const all = this.body.all();
    if (sel === 'details[data-key]') return all.filter((e) => e.tagName === 'DETAILS' && e.dataset.key !== undefined);
    if (sel === '[data-focus]') return all.filter((e) => e.dataset.focus !== undefined);
    throw new Error(`unsupported selector ${sel}`);
  }
  addEventListener(type: string, l: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  fire(type: string, e: any): void {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
}

function runScript(html: string, saved?: unknown) {
  const doc = new FakeDoc();
  const win = new FakeDoc(); // 이벤트 대상으로만 써요
  const store = { state: saved === undefined ? undefined : JSON.parse(JSON.stringify(saved)), sets: 0 };
  const selection = { text: '', inBody: true };
  const posted: unknown[] = [];
  const sandbox = {
    document: doc,
    window: {
      scrollY: 0,
      addEventListener: (t: string, l: Listener) => win.addEventListener(t, l),
      getSelection: () => {
        const node = selection.inBody ? doc.body.children[0] ?? doc.body : null;
        return { isCollapsed: !selection.text, rangeCount: selection.text ? 1 : 0, anchorNode: node, focusNode: node, toString: () => selection.text };
      },
    },
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    acquireVsCodeApi: () => ({
      postMessage: (m: unknown) => void posted.push(m),
      getState: () => store.state,
      setState: (s: unknown) => {
        store.state = JSON.parse(JSON.stringify(s)); // VS Code처럼 직렬화돼요
        store.sets++;
      },
    }),
    setTimeout,
  };
  const body = /<body>([\s\S]*?)<script nonce="[^"]+">/.exec(html)![1]!;
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
  doc.body.innerHTML = body;
  vm.runInNewContext(script, sandbox);
  const details = (key: string) => doc.querySelectorAll('details[data-key]').find((d) => d.dataset.key === key);
  return {
    doc,
    posted,
    store,
    selection,
    details,
    post: (b: string) => win.fire('message', { data: { body: b } }),
    /** 사용자가 summary를 눌러요: click → (기본 동작) 펼침 바뀜 → toggle */
    click(key: string) {
      const d = details(key)!;
      const s = d.firstElementChild!;
      s.focus();
      doc.fire('click', { target: s, defaultPrevented: false });
      d.open = !d.open;
      setTimeout(() => doc.fire('toggle', { target: d }));
    },
    pointer: (type: 'pointerdown' | 'pointerup') => win.fire(type, {}),
  };
}

const bodyOf = (t: SessionTasks) => renderTasksBody({ tasks: t, now: NOW });

test('tasks script: default-open details are not remembered; a summary click is, across swaps and a rebuilt webview', async () => {
  const running = tasksFor(SID, 2);
  const done = tasksFor(SID, 0);
  const w = runScript(renderTasksHtml({ tasks: running, now: NOW }, 'TESTNONCE'));
  await settle();
  assert.equal(w.details('wf:wf_1')!.open, true, 'running workflow agents open by default');
  assert.equal(w.store.sets, 0, 'the toggle from parsing an open <details> is not a user choice');
  // 끝나면 기본으로 접혀요 — 기본으로 열렸던 걸 기억해 다시 열면 안 돼요
  w.post(bodyOf(done));
  await settle();
  assert.equal(w.details('wf:wf_1')!.open, false, 'default (closed) applies once the workflow finished');
  assert.equal(w.details('ended')!.open, true, 'nothing running: ended subagents open by default');
  assert.equal(w.store.sets, 0);

  // 사용자가 끝난 워크플로우의 agent를 펼치고, 끝난 서브에이전트는 접어요
  w.click('wf:wf_1');
  w.click('ended');
  await settle();
  assert.deepEqual(w.store.state, { open: { 'wf:wf_1': true, ended: false } });
  w.post(bodyOf(done));
  await settle();
  assert.equal(w.details('wf:wf_1')!.open, true, 'user choice survives a swap');
  assert.equal(w.details('ended')!.open, false);

  // 숨겼다 다시 보이면 웹뷰가 새로 떠요 — 저장한 선택을 바로 적용해요
  const again = runScript(renderTasksHtml({ tasks: done, now: NOW }, 'TESTNONCE'), w.store.state);
  assert.equal(again.details('wf:wf_1')!.open, true, 'restored on load from getState');
  assert.equal(again.details('ended')!.open, false);
  await settle();
  assert.deepEqual(again.store.state, { open: { 'wf:wf_1': true, ended: false } }, 'load-time toggles do not overwrite saved choices');
});

test('tasks script: focus on a summary follows the swap; a text selection holds the swap until it is released', async () => {
  const w = runScript(renderTasksHtml({ tasks: tasksFor(SID, 2), now: NOW }, 'TESTNONCE'));
  await settle();
  w.click('wf:wf_1'); // 포커스가 summary에 있어요
  await settle();
  w.post(bodyOf(tasksFor(SID, 0)));
  const s = w.details('wf:wf_1')!.firstElementChild!;
  assert.equal(w.doc.activeElement, s, 'focus moved to the new summary with the same key');

  // 본문 안에 글자를 선택 중이면 바꾸지 않아요
  w.selection.text = 'lane A';
  const before = w.details('wf:wf_1');
  w.post(bodyOf(tasksFor(SID, 2)).replace('lane A', 'lane B'));
  assert.equal(w.details('wf:wf_1'), before, 'not swapped while selecting');
  // 단추를 누르는 동안 선택이 풀려도 뗄 때까지 기다려요
  w.pointer('pointerdown');
  w.selection.text = '';
  w.doc.fire('selectionchange', {});
  await settle();
  assert.equal(w.details('wf:wf_1'), before, 'held while the pointer is down');
  w.pointer('pointerup');
  await settle();
  assert.notEqual(w.details('wf:wf_1'), before, 'pending body applied once the selection is gone');

  // 본문 밖 선택은 막지 않아요
  w.selection.text = 'elsewhere';
  w.selection.inBody = false;
  const cur = w.details('wf:wf_1');
  w.post(bodyOf(tasksFor(SID, 0)));
  assert.notEqual(w.details('wf:wf_1'), cur);
});

test('tasks: non-agent windows never ask the daemon and clear the agent kind', async () => {
  const { m, daemon, status } = monitor({});
  try {
    await settle();
    assert.equal(daemon.calls.length, 0);
    assert.deepEqual(ctx(), ['']);
    assert.equal(status.visible, false);
    assert.match(renderTasksHtml(m.model()), /에이전트 창에서만/);
  } finally {
    m.dispose();
  }
});

test('tasks: the content height from the webview sizes the view through the Mk42 command (debounced); older builds ignore it', async () => {
  const { m } = monitor({ agent: 'claude' });
  try {
    const fits: unknown[][] = [];
    vs.state.commandImpl.set(FIT_HEIGHT_COMMAND, (...a: unknown[]) => void fits.push(a));
    const view = vs.createWebviewView(TASKS_VIEW_IDS.claude);
    m.resolveWebviewView(view as never);
    await settle();
    view.webview.received.fire({ type: 'height', px: 120 });
    view.webview.received.fire({ type: 'height', px: 180 });
    view.webview.received.fire({ type: 'height', px: 'x' });
    await settle(400);
    assert.deepEqual(fits, [[TASKS_VIEW_IDS.claude, 180]], 'only the last height, once');
  } finally {
    m.dispose();
  }
});

test('tasks script: reports its content height after each swap', async () => {
  const html = renderTasksHtml({ message: 'a\nb' } as never, 'n0nce');
  const s = runScript(html);
  await settle(20);
  const first = s.posted.filter((p) => (p as { type?: string }).type === 'height').length;
  assert.ok(first >= 1, 'on load');
  s.post('<div>x</div><div>y</div><div>z</div>');
  await settle(20);
  const heights = s.posted.filter((p) => (p as { type?: string }).type === 'height') as { px: number }[];
  assert.ok(heights.length > first && heights.at(-1)!.px > heights[0]!.px, 'taller content, larger height');
});
