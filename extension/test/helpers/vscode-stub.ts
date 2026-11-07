// 테스트용 최소 vscode 모듈 — 확장이 쓰는 표면만 흉내 내고 호출을 기록해요.
import { readFileSync } from 'node:fs';

type Listener<T> = (e: T) => void;

/** 한국어 언어 번들(영어 원문 → 한국어) — 기본으로 이걸로 번역해서, 시험이 지금 한국어 화면 글을 그대로 봐요 */
export const KO_BUNDLE = JSON.parse(readFileSync(new URL('../../l10n/bundle.l10n.ko.json', import.meta.url), 'utf8')) as Record<string, string>;

export class EventEmitter<T> {
  #ls = new Set<Listener<T>>();
  event = (l: Listener<T>) => {
    this.#ls.add(l);
    return { dispose: () => this.#ls.delete(l) };
  };
  fire(e: T): void {
    for (const l of [...this.#ls]) l(e);
  }
  dispose(): void {
    this.#ls.clear();
  }
}

export class Uri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fsPath: string;
  #raw: string;
  constructor(raw: string, scheme: string, fsPath: string) {
    this.#raw = raw;
    this.scheme = scheme;
    this.fsPath = fsPath;
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(raw);
    this.authority = m?.[1] ?? '';
    this.path = m?.[2] ?? '';
    this.query = m?.[3] ?? '';
  }
  static parse(s: string): Uri {
    const scheme = s.slice(0, Math.max(0, s.indexOf(':')));
    return new Uri(s, scheme, scheme === 'file' ? decodeURIComponent(s.replace(/^file:\/\/\//, '')).replace(/\//g, '\\') : s);
  }
  static file(p: string): Uri {
    return new Uri(`file:///${p.replace(/\\/g, '/')}`, 'file', p);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return Uri.file([base.fsPath, ...parts].join('\\'));
  }
  toString(): string {
    return this.#raw;
  }
}

export class ThemeIcon {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}
export class ThemeColor {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}
export class MarkdownString {
  value = '';
  appendText(s: string): this {
    this.value += s;
    return this;
  }
}
export class TreeItem {
  label: string;
  collapsibleState: number | undefined;
  description?: string;
  constructor(label: string, state?: number) {
    this.label = label;
    this.collapsibleState = state;
  }
}
export class Position {
  line: number;
  character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}
export class Range {
  start: Position;
  end: Position;
  constructor(sl: number, sc: number, el: number, ec: number) {
    this.start = new Position(sl, sc);
    this.end = new Position(el, ec);
  }
}
export class TabInputText {
  uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }
}
export class TabInputTextDiff {
  original: Uri;
  modified: Uri;
  constructor(o: Uri, m: Uri) {
    this.original = o;
    this.modified = m;
  }
}
export class TabInputCustom {
  uri: Uri;
  viewType: string;
  constructor(uri: Uri, viewType: string) {
    this.uri = uri;
    this.viewType = viewType;
  }
}
export class TabInputNotebook {
  uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }
}
export class TabInputWebview {
  viewType: string;
  constructor(viewType: string) {
    this.viewType = viewType;
  }
}

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const version = '1.142.0';

// ---- 기록·조작용 상태
export const state = {
  /** 작업 영역(워크스페이스 파일) 설정 */
  config: {} as Record<string, unknown>,
  /** 사용자 설정 */
  globalConfig: {} as Record<string, unknown>,
  commands: new Map<string, (...a: unknown[]) => unknown>(),
  executed: [] as { id: string; args: unknown[] }[],
  messages: [] as { level: string; text: string }[],
  /** 다음 show*Message가 고를 단추(차례로) */
  answers: [] as (string | undefined)[],
  openedExternal: [] as string[],
  closedTabs: [] as unknown[],
  /** window.tabGroups.all */
  tabGroups: [] as { tabs: unknown[] }[],
  panels: [] as {
    viewType: string;
    title: string;
    html: string;
    posted: unknown[];
    receive: EventEmitter<unknown>;
  }[],
  focused: true,
  /** workspace.isTrusted (제한 모드 시험) */
  trusted: true,
  trustGranted: new EventEmitter<void>(),
  extensionsChanged: new EventEmitter<void>(),
  workspaceFile: undefined as Uri | undefined,
  workspaceFolders: [] as { uri: Uri }[],
  extensions: new Map<string, { id: string; packageJSON: { version: string }; isActive: boolean; activate(): Promise<void> }>(),
  tabsChanged: new EventEmitter<{ opened: unknown[]; changed: unknown[]; closed: unknown[] }>(),
  configChanged: new EventEmitter<{ affectsConfiguration(s: string): boolean }>(),
  activeTextEditor: undefined as unknown,
  /** executeCommand 결과를 바꾸고 싶을 때 */
  commandImpl: new Map<string, (...a: unknown[]) => unknown>(),
  /** createStatusBarItem으로 만든 항목(만든 순서) */
  statusItems: [] as StubStatusItem[],
  /** registerWebviewViewProvider로 등록한 보기 공급자 */
  webviewViewProviders: new Map<string, { resolveWebviewView(view: unknown): unknown }>(),
  /** createTreeView로 만든 트리 보기 — changes: 공급자가 onDidChangeTreeData를 쏜 횟수 */
  treeViews: new Map<string, { changes: number }>(),
  /** l10n.t가 쓸 번들 — undefined면 영어 원문 그대로 */
  l10nBundle: KO_BUNDLE as Record<string, string> | undefined,
  /** 번들에 없어서 원문으로 낸 l10n.t 원문(번들 빠짐 확인용) */
  l10nMissing: new Set<string>(),
  /** env.language */
  language: 'ko',
};

export interface StubStatusItem {
  id: string | undefined;
  visible: boolean;
  text: string;
  tooltip: unknown;
  command: unknown;
  name: string;
  backgroundColor: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** 시험용 WebviewView — 공급자의 resolveWebviewView에 넘겨요. setVisible·close로 보기를 조작해요 */
export function createWebviewView(viewType: string, visible = true) {
  const visibility = new EventEmitter<void>();
  const disposed = new EventEmitter<void>();
  const view = {
    viewType,
    visible,
    title: undefined as string | undefined,
    description: undefined as string | undefined,
    badge: undefined as { value: number; tooltip: string } | undefined,
    /** html을 쓴 횟수 */
    writes: 0,
    webview: {
      options: {} as Record<string, unknown>,
      cspSource: 'https://stub.vscode-cdn.net',
      _html: '',
      get html() {
        return this._html;
      },
      set html(v: string) {
        this._html = v;
        view.writes++;
      },
      /** 웹뷰 → 확장 메시지 */
      received: new EventEmitter<unknown>(),
      onDidReceiveMessage(l: (m: unknown) => void) {
        return view.webview.received.event(l);
      },
      /** 받은 메시지 — {body}면 웹뷰 스크립트처럼 본문을 바꿔 끼워요(스크립트 태그는 그대로) */
      posted: [] as unknown[],
      async postMessage(msg: unknown): Promise<boolean> {
        view.webview.posted.push(msg);
        const body = (msg as { body?: unknown } | undefined)?.body;
        if (typeof body === 'string') view.webview._html = view.webview._html.replace(/(<body>)[\s\S]*?(<script)/, (_m, a, b) => `${a}${body}${b}`);
        return true;
      },
    },
    onDidChangeVisibility: visibility.event,
    onDidDispose: disposed.event,
    show() {},
    setVisible(v: boolean) {
      view.visible = v;
      visibility.fire();
    },
    close() {
      disposed.fire();
    },
  };
  return view;
}

export function reset(): void {
  state.config = {};
  state.globalConfig = {};
  state.commands.clear();
  state.executed = [];
  state.messages = [];
  state.answers = [];
  state.openedExternal = [];
  state.closedTabs = [];
  state.tabGroups = [];
  state.panels = [];
  state.focused = true;
  state.trusted = true;
  state.trustGranted = new EventEmitter<void>();
  state.extensionsChanged = new EventEmitter<void>();
  state.workspaceFile = undefined;
  state.workspaceFolders = [];
  state.extensions.clear();
  state.tabsChanged = new EventEmitter();
  state.configChanged = new EventEmitter();
  state.activeTextEditor = undefined;
  state.commandImpl.clear();
  state.statusItems = [];
  state.webviewViewProviders.clear();
  state.treeViews.clear();
  state.l10nBundle = KO_BUNDLE;
  state.l10nMissing.clear();
  state.language = 'ko';
}

/** vscode.l10n — t(원문, ...인자) / t(원문, {이름: 값}) / t({message, args}) */
export const l10n = {
  bundle: undefined as Record<string, string> | undefined,
  uri: undefined,
  t(first: string | { message: string; args?: unknown[] | Record<string, unknown> }, ...rest: unknown[]): string {
    const message = typeof first === 'string' ? first : first.message;
    const args: unknown = typeof first === 'string' ? (rest.length === 1 && rest[0] !== null && typeof rest[0] === 'object' ? rest[0] : rest) : (first.args ?? []);
    const b = state.l10nBundle;
    let text = message;
    if (b) {
      if (Object.hasOwn(b, message)) text = b[message]!;
      else state.l10nMissing.add(message);
    }
    return text.replace(/\{([^{}]+)\}/g, (whole, key: string) => {
      const v = Array.isArray(args) ? args[Number(key)] : (args as Record<string, unknown>)[key];
      return v === undefined ? whole : String(v);
    });
  },
};

const noop = { dispose() {} };

function msg(level: string) {
  return async (text: string) => {
    state.messages.push({ level, text });
    return state.answers.shift();
  };
}

export const window = {
  get state() {
    return { focused: state.focused };
  },
  get activeTextEditor() {
    return state.activeTextEditor;
  },
  createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() {} }),
  createStatusBarItem: (id?: string) => {
    const it: StubStatusItem = {
      id,
      visible: false,
      text: '',
      tooltip: '',
      command: '',
      name: '',
      backgroundColor: undefined,
      show() {
        it.visible = true;
      },
      hide() {
        it.visible = false;
      },
      dispose() {},
    };
    state.statusItems.push(it);
    return it;
  },
  registerWebviewViewProvider: (id: string, provider: { resolveWebviewView(view: unknown): unknown }) => {
    state.webviewViewProviders.set(id, provider);
    return { dispose: () => state.webviewViewProviders.delete(id) };
  },
  createTreeView: (id: string, o?: { treeDataProvider?: { onDidChangeTreeData?: (l: () => void) => { dispose(): void } } }) => {
    const rec = { changes: 0 };
    state.treeViews.set(id, rec);
    const sub = o?.treeDataProvider?.onDidChangeTreeData?.(() => rec.changes++);
    return { dispose: () => sub?.dispose(), message: undefined };
  },
  createWebviewPanel: (viewType: string, title: string) => {
    const receive = new EventEmitter<unknown>();
    const disposeEmitter = new EventEmitter<void>();
    const rec = { viewType, title, html: '', posted: [] as unknown[], receive };
    state.panels.push(rec);
    const webview = {
      cspSource: 'https://stub.vscode-cdn.net',
      asWebviewUri: (u: Uri) => Uri.parse(`https://stub.vscode-cdn.net/${u.fsPath.replace(/\\/g, '/')}`),
      postMessage: async (m: unknown) => {
        rec.posted.push(m);
        return true;
      },
      onDidReceiveMessage: receive.event,
      set html(v: string) {
        rec.html = v;
      },
      get html() {
        return rec.html;
      },
    };
    return { webview, reveal() {}, dispose: () => disposeEmitter.fire(), onDidDispose: disposeEmitter.event, iconPath: undefined };
  },
  tabGroups: {
    get all() {
      return state.tabGroups;
    },
    onDidChangeTabs: (l: Listener<{ opened: unknown[]; changed: unknown[]; closed: unknown[] }>) => state.tabsChanged.event(l),
    close: async (tab: unknown) => {
      state.closedTabs.push(tab);
      return true;
    },
  },
  onDidChangeWindowState: () => noop,
  activeColorTheme: { kind: 2 },
  onDidChangeActiveColorTheme: () => noop,
  showInformationMessage: msg('info'),
  withProgress: async <T>(_o: unknown, task: (p: { report(v: unknown): void }) => Promise<T>) => task({ report() {} }),
  showWarningMessage: msg('warn'),
  showErrorMessage: msg('error'),
  showQuickPick: async () => undefined,
  showOpenDialog: async () => undefined,
};

export const workspace = {
  getConfiguration: (section: string) => ({
    get: (k: string) => state.config[`${section}.${k}`] ?? state.globalConfig[`${section}.${k}`],
    inspect: (k: string) => ({
      workspaceValue: state.config[`${section}.${k}`],
      globalValue: state.globalConfig[`${section}.${k}`],
    }),
    update: async () => {},
  }),
  onDidChangeConfiguration: (l: Listener<{ affectsConfiguration(s: string): boolean }>) => state.configChanged.event(l),
  get isTrusted() {
    return state.trusted;
  },
  onDidGrantWorkspaceTrust: (l: Listener<void>) => state.trustGranted.event(l),
  get workspaceFile() {
    return state.workspaceFile;
  },
  get workspaceFolders() {
    return state.workspaceFolders;
  },
};

export const commands = {
  registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => {
    state.commands.set(id, fn);
    return { dispose: () => state.commands.delete(id) };
  },
  getCommands: async () => [...state.commands.keys(), ...state.commandImpl.keys()],
  executeCommand: async (id: string, ...args: unknown[]) => {
    state.executed.push({ id, args });
    const impl = state.commandImpl.get(id) ?? state.commands.get(id);
    return impl ? impl(...args) : undefined;
  },
};

export const extensions = {
  getExtension: (id: string) => state.extensions.get(id),
  all: [] as { extensionPath: string; packageJSON: unknown }[],
  onDidChange: (l: Listener<void>) => state.extensionsChanged.event(l),
};

export const env = {
  uriScheme: 'vscode',
  appName: 'Visual Studio Code',
  get language() {
    return state.language;
  },
  openExternal: async (u: Uri) => {
    state.openedExternal.push(u.toString());
    return true;
  },
  /** 실제 VS Code는 product-scheme URI에 windowId 쿼리를 붙여요(RelayURLService.create) */
  asExternalUri: async (u: Uri) => Uri.parse(`${u.toString()}${u.query ? '&' : '?'}windowId=1`),
  clipboard: { readText: async () => '', writeText: async () => {} },
};

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
