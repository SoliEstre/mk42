// 명령 한 줄에서 에이전트 CLI(claude·codex·grok·agy) 호출 찾기 — «실행» 명령을 «작업»에 CLI 뱃지로 올릴 때 써요.
// 셸처럼 토큰으로 나눠 «명령어 자리»만 봐요. 다른 명령의 문자열·heredoc 안 언급(git commit -m, echo, cat > f <<EOF, grep,
// python -c …)이나 경로·npm 스크립트 이름은 세지 않고, 실제로 실행되는 문자열(bash -c, powershell -Command, cmd /c,
// ssh host CMD, bash <<EOF 본문, $(…))만 다시 들어가요. 감싸는 명령(timeout·env·sudo·nohup·npx·wsl·Start-Process …)은 건너뛰어요.
// 일을 시키는 호출만 돌려줘요(--help·--version·models·plugin·login 같은 확인 호출은 빼요). 모델·effort는 허용 모양만 실어요.
// 안전: 앞 64 KB만 보고, 되돌아가며 매칭하는 정규식 없이 손으로 훑고, 재귀 깊이·호출 수에 상한을 두고, 절대 throw하지 않아요.
// 결과와 오류 어디에도 명령 본문을 싣지 않아요(명령에 프롬프트·비밀이 들어 있을 수 있어요).
import { AGENT_CLIS, type AgentCli, type AgentCliCall } from '@mark42/protocol';

/** 이만큼만 봐요(그 뒤는 잘라요) */
export const AGENT_CLI_MAX_INPUT = 64 * 1024;
/** 실행되는 문자열 안으로 다시 들어가는 깊이 */
const MAX_DEPTH = 4;
/** 명령 하나에서 돌려주는 호출 수 */
export const AGENT_CLI_MAX_CALLS = 32;
/** 다시 읽는 글자 총량(재귀·되붙인 문자열 포함) — 입력 크기에 비례하게 묶어요 */
const MAX_WORK = 4 * AGENT_CLI_MAX_INPUT;
/** 감싸는 명령을 벗기는 횟수 */
const MAX_UNWRAP = 64;
/** 토큰 나누기 한 번에 만드는 명령·낱말 수 */
const MAX_CMDS = 2048;
const MAX_WORDS = 8192;
const MAX_SUBS = 256;
/** 문자열을 토큰으로 나누는 횟수(재귀 전체) */
const MAX_SCANS = 512;

const CLIS: ReadonlySet<string> = new Set<string>(AGENT_CLIS);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'git-bash']);
const PWSH = new Set(['powershell', 'pwsh']);
/** 명령어 자리 앞에 오는 셸 키워드 */
const KEYWORDS = new Set(['!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time']);
/** 그냥 앞에 붙는 감싸기(옵션만 건너뛰어요) */
const PLAIN_WRAPPERS = new Set(['sudo', 'nohup', 'exec', 'stdbuf', 'nice', 'caffeinate']);
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
/** 모든 CLI 공통 확인 플래그 */
const HELP_FLAGS = new Set(['-h', '--help', '-V', '--version', '-v']);

interface CliSpec {
  /** 첫 위치 인자가 이것이면 확인 호출(meta) */
  meta: ReadonlySet<string>;
  /** 첫 위치 인자가 이것이면 일을 시키는 호출 */
  agentSubs: ReadonlySet<string>;
  /** 값을 받는 플래그(값을 프롬프트로 잘못 세지 않게) */
  valued: ReadonlySet<string>;
  /** 이 플래그가 있으면 일을 시키는 호출 */
  prompt: ReadonlySet<string>;
  model: ReadonlySet<string>;
  effort: ReadonlySet<string>;
  /** -c key=value 설정(codex) */
  config: ReadonlySet<string>;
}

const set = (s: string): ReadonlySet<string> => new Set(s ? s.split(' ') : []);

// 짧은 플래그 뜻이 CLI마다 달라요: -p는 claude·agy print, grok 한 턴 프롬프트, codex는 profile. -c는 continue인데 codex는 config.
const SPECS: Record<AgentCli, CliSpec> = {
  claude: {
    meta: set('mcp plugin plugins update upgrade doctor config install setup-token migrate-installer auth login logout remote-control help agents'),
    agentSubs: set(''),
    valued: set(
      '--model --effort --output-format --input-format --permission-mode --allowedTools --allowed-tools --disallowedTools --disallowed-tools --tools --agent --agents --add-dir --mcp-config --settings --system-prompt --append-system-prompt --fallback-model --max-turns --max-budget-usd --session-id -r --resume --json-schema --plugin-dir --setting-sources --permission-prompt-tool --betas --debug-file',
    ),
    prompt: set('-p --print -c --continue -r --resume'),
    model: set('--model'),
    effort: set('--effort'),
    config: set(''),
  },
  codex: {
    meta: set(
      'login logout mcp plugin app-server remote-control app completion update doctor sandbox debug apply a archive delete unarchive features help exec-server migrate-rollouts migrate-nfs-db cloud agents mcp-server',
    ),
    agentSubs: set('exec e review resume fork queue'),
    valued: set(
      '-m --model -c --config -p --profile -s --sandbox -a --ask-for-approval -C --cd -o --output-last-message --output-schema --color -i --image --enable --disable --add-dir --local-provider --remote --remote-auth-token-env',
    ),
    // codex 맨 앞 위치 인자 프롬프트 = 대화형 세션(위치 인자로 잡아요). -p는 profile이라 프롬프트 플래그가 아니에요
    prompt: set(''),
    model: set('-m --model'),
    // effort 전용 플래그는 없어요(-c model_reasoning_effort=…만)
    effort: set(''),
    config: set('-c --config'),
  },
  grok: {
    meta: set(
      'clone completions dashboard doctor du disk-usage export help inspect leader login logout mcp memory models plugin sessions setup trace update usage version v worker worktree wrap',
    ),
    agentSubs: set('agent'),
    valued: set(
      '-m --model --reasoning-effort --effort --output-format --permission-mode --prompt-file --prompt-json -p --single --cwd --max-turns --agent --agents --allow --deny --allowedTools --allowed-tools --disallowedTools --disallowed-tools --tools --sandbox --rules --system-prompt --system-prompt-override --json-schema -s --session-id --add-dir --debug-file --leader-socket --worktree-ref --ref',
    ),
    prompt: set('-p --single --prompt-file --prompt-json -c --continue -r --resume'),
    model: set('-m --model'),
    effort: set('--reasoning-effort --effort'),
    config: set(''),
  },
  agy: {
    meta: set('acp agent agents changelog help install mcp mic-serve models plugin plugins remote-control update'),
    agentSubs: set(''),
    valued: set(
      '--model --effort --output-format --input-format --mode --agent --add-dir --conversation --json-schema --log-file --print-timeout --project --settings -p --print --prompt -i --prompt-interactive',
    ),
    prompt: set('-p --print --prompt -i --prompt-interactive -c --continue --conversation'),
    model: set('--model'),
    effort: set('--effort'),
    config: set(''),
  },
};

// ---- 글자 판별(정규식 없이)

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isNameStart(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
}
function isNameChar(c: string): boolean {
  return isNameStart(c) || isDigit(c);
}
function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n';
}

/** `NAME=…`(bash) · `$name=…`·`$env:NAME=…`(PowerShell) 이면 이름, 아니면 undefined */
function assignName(s: string): { name: string; ps: boolean } | undefined {
  let i = 0;
  const ps = s.charAt(0) === '$';
  if (ps) i = 1;
  if (!isNameStart(s.charAt(i))) return undefined;
  const start = i;
  while (i < s.length && (isNameChar(s.charAt(i)) || (ps && s.charAt(i) === ':'))) i++;
  if (s.charAt(i) !== '=') return undefined;
  return { name: s.slice(start, i), ps };
}

/** `$NAME` · `${NAME}` 하나뿐인 낱말이면 이름 */
function varRef(v: string): string | undefined {
  if (v.charAt(0) !== '$') return undefined;
  let body = v.slice(1);
  if (body.charAt(0) === '{') {
    if (body.charAt(body.length - 1) !== '}') return undefined;
    body = body.slice(1, -1);
  }
  if (!body || !isNameStart(body.charAt(0))) return undefined;
  for (let i = 1; i < body.length; i++) if (!isNameChar(body.charAt(i))) return undefined;
  return body;
}

/** 명령어 낱말 → 비교용 이름(경로 떼고 소문자, .exe·.cmd·.bat·.ps1 떼고, npm 패키지 이름은 CLI로) */
function baseName(word: string): string {
  let w = word;
  if (w.charAt(0) === '"' || w.charAt(0) === "'") w = w.slice(1);
  const last = w.charAt(w.length - 1);
  if (last === '"' || last === "'") w = w.slice(0, -1);
  const lower = w.toLowerCase();
  const pkg = (name: string): boolean => lower === name || (lower.startsWith(name + '@') && !lower.slice(name.length + 1).includes('/'));
  if (pkg('@anthropic-ai/claude-code')) return 'claude';
  if (pkg('@openai/codex')) return 'codex';
  const cut = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
  let b = cut >= 0 ? lower.slice(cut + 1) : lower;
  for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
    if (b.endsWith(ext)) {
      b = b.slice(0, -ext.length);
      break;
    }
  }
  return b;
}

function modelOk(v: string | undefined): v is string {
  if (!v || v.length > 64) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charAt(i);
    if (!(isNameChar(c) || c === '.' || c === ':' || c === '[' || c === ']' || c === '-')) return false;
  }
  return true;
}

function effortOf(v: string | undefined): string | undefined {
  if (!v || v.length > 16) return undefined;
  const e = v.toLowerCase();
  return EFFORTS.has(e) ? e : undefined;
}

function unquote(v: string): string {
  const s = v.trim();
  const a = s.charAt(0);
  if (s.length >= 2 && (a === '"' || a === "'") && s.charAt(s.length - 1) === a) return s.slice(1, -1);
  return s;
}

// ---- 토큰 나누기

interface Word {
  /** 따옴표를 벗긴 값 */
  v: string;
  /** 따옴표가 섞였어요 */
  q: boolean;
  /** 처음 따옴표가 나오기 전까지의 맨 글자(대입 판별용) */
  lead: string;
  /** 리다이렉션 연산자(>, 2>&1, <<, <<< …) */
  redir?: boolean;
  /** 리다이렉션 대상 낱말 */
  target?: string;
}

interface SimpleCmd {
  words: Word[];
  /** 이 명령에 붙은 heredoc 본문 */
  heredocs: string[];
  /** 이 명령 안의 $(…)·`…` (명령보다 먼저 실행돼요) */
  subs: string[];
  /** PowerShell 호출 연산자 & 뒤(또는 bash 백그라운드 & 뒤) */
  call: boolean;
}

interface Heredoc {
  tag: string;
  cmd: SimpleCmd;
}

interface Tok {
  cmds: SimpleCmd[];
  cur: SimpleCmd;
  w: Word | undefined;
  /** 지금까지 만든 낱말 수(상한 MAX_WORDS) */
  words: number;
  /** 지금까지 모은 $(…) 수(상한 MAX_SUBS — 넘으면 건너뛰기만 해요) */
  subs: number;
}

function newCmd(call = false): SimpleCmd {
  return { words: [], heredocs: [], subs: [], call };
}
function flushWord(t: Tok): void {
  if (t.w) {
    t.cur.words.push(t.w);
    t.words++;
    t.w = undefined;
  }
}
function addSub(t: Tok, s: string): void {
  if (s && t.subs++ < MAX_SUBS) t.cur.subs.push(s);
}
function pushRedir(t: Tok, op: string): void {
  flushWord(t);
  t.cur.words.push({ v: op, q: false, lead: '', redir: true });
  t.words++;
}
function flushCmd(t: Tok, call = false): void {
  flushWord(t);
  const c = t.cur;
  if (c.words.length || c.heredocs.length || c.subs.length) {
    t.cmds.push(c);
    t.cur = newCmd(call);
  } else c.call = call; // 빈 명령은 다시 써요
}
function wordOf(t: Tok): Word {
  if (!t.w) t.w = { v: '', q: false, lead: '' };
  return t.w;
}
/** 맨 글자 붙이기 */
function addPlain(t: Tok, s: string): void {
  const w = wordOf(t);
  w.v += s;
  if (!w.q) w.lead += s;
}
/** 따옴표 안 글자 붙이기 */
function addQuoted(t: Tok, s: string): void {
  const w = wordOf(t);
  w.q = true;
  w.v += s;
}

/** open 위치의 ( 와 짝인 ) 위치(없으면 s.length). 따옴표 안은 건너뛰어요 — 늘 앞으로만 가요 */
function matchParen(s: string, open: number): number {
  let d = 0;
  for (let k = open; k < s.length; k++) {
    const c = s.charAt(k);
    if (c === '(') d++;
    else if (c === ')') {
      d--;
      if (d === 0) return k;
    } else if (c === "'" || c === '"') {
      const e = s.indexOf(c, k + 1);
      if (e > 0) k = e;
    }
  }
  return s.length;
}

/** 토큰 경계가 될 수 있는 글자(맨 글자 묶음을 여기서 끊어요) */
const SPECIAL: ReadonlySet<string> = new Set([' ', '\t', '\r', '\n', '#', '(', ')', ';', '{', '}', '|', '&', '<', '>', "'", '"', '$', '`', '\\', '@']);

function tokenize(src: string): SimpleCmd[] {
  const t: Tok = { cmds: [], cur: newCmd(), w: undefined, words: 0, subs: 0 };
  let pending: Heredoc[] = [];
  const n = src.length;
  let i = 0;
  // 명령·낱말 수에 상한 — 넘으면 거기까지만 봐요
  while (i < n && t.cmds.length < MAX_CMDS && t.words < MAX_WORDS) {
    const c = src.charAt(i);
    const c1 = src.charAt(i + 1);
    if (c === '\n') {
      flushWord(t);
      if (pending.length) {
        // 줄바꿈 뒤부터 heredoc 본문 — 선언한 명령에 붙여요
        let j = i + 1;
        for (const h of pending) {
          const start = j;
          let end = n;
          while (j < n) {
            let e = src.indexOf('\n', j);
            if (e < 0) e = n;
            const lineStart = j;
            j = e + 1;
            // 끝 표시 줄은 짧아요 — 긴 줄은 잘라 비교하지 않아요
            if (e - lineStart <= h.tag.length + 64 && src.slice(lineStart, e).trim() === h.tag) {
              end = lineStart;
              break;
            }
          }
          h.cmd.heredocs.push(src.slice(start, end === n ? n : Math.max(start, end - 1)));
        }
        pending = [];
        i = Math.min(j, n);
        flushCmd(t);
        continue;
      }
      flushCmd(t);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flushWord(t);
      i++;
      continue;
    }
    if (c === '#' && !t.w) {
      while (i < n && src.charAt(i) !== '\n') i++;
      continue;
    }
    if (c === '(' && t.w) {
      // PowerShell 메서드 호출 X(...)는 낱말의 일부
      const e = matchParen(src, i);
      addPlain(t, src.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    if (c === ';' || c === '(' || c === ')' || (c === '{' && !t.w && (c1 === '' || isSpace(c1))) || (c === '}' && !t.w)) {
      flushCmd(t);
      i++;
      continue;
    }
    if (c === '|') {
      flushCmd(t);
      i += c1 === '|' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (c1 === '&') {
        flushCmd(t);
        i += 2;
        continue;
      }
      if (c1 === '>') {
        flushWord(t);
        pushRedir(t, '&>');
        i += 2;
        continue;
      }
      // 백그라운드 & 또는 PowerShell 호출 연산자 &
      flushCmd(t, true);
      i++;
      continue;
    }
    if (c === '<' && c1 === '<' && src.charAt(i + 2) !== '<') {
      // heredoc <<[-]['"]TAG — 본문은 다음 줄부터(끝 표시 줄은 앞뒤 공백·탭을 떼고 비교해요)
      let j = i + 2;
      if (src.charAt(j) === '-') j++;
      while (src.charAt(j) === ' ') j++;
      let tag = '';
      const q = src.charAt(j);
      if (q === "'" || q === '"') {
        const e = src.indexOf(q, j + 1);
        const end = e < 0 ? n : e;
        tag = src.slice(j + 1, end);
        j = end + 1;
      } else {
        const s = j;
        while (j < n && (isNameChar(src.charAt(j)) || src.charAt(j) === '\\')) j++;
        tag = src.slice(s, j);
      }
      tag = tag.split('\\').join('');
      if (tag && tag.length <= 256) {
        flushWord(t);
        pending.push({ tag, cmd: t.cur });
        pushRedir(t, '<<');
        i = Math.min(j, n);
        continue;
      }
    }
    if (c === '@' && (c1 === "'" || c1 === '"') && (src.charAt(i + 2) === '\n' || (src.charAt(i + 2) === '\r' && src.charAt(i + 3) === '\n'))) {
      // PowerShell here-string @' … '@
      const end = src.indexOf('\n' + c1 + '@', i + 2);
      let body = src.slice(i + 2, end < 0 ? n : end);
      if (body.startsWith('\r\n')) body = body.slice(2);
      else if (body.startsWith('\n')) body = body.slice(1);
      if (body.endsWith('\r')) body = body.slice(0, -1);
      addQuoted(t, body);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      addQuoted(t, src.slice(i + 1, e < 0 ? n : e));
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n && src.charAt(j) !== '"') {
        const d = src.charAt(j);
        const d1 = src.charAt(j + 1);
        if (d === '\\' && (d1 === '"' || d1 === '\\' || d1 === '$' || d1 === '`' || d1 === '\n')) {
          v += d1;
          j += 2;
          continue;
        }
        if (d === '`' && j + 1 < n) {
          // PowerShell 이스케이프
          v += d1;
          j += 2;
          continue;
        }
        if (d === '$' && d1 === '(') {
          const e = matchParen(src, j + 1);
          addSub(t, src.slice(j + 2, e));
          v += '$(…)';
          j = e + 1;
          continue;
        }
        v += d;
        j++;
      }
      addQuoted(t, v);
      i = j + 1;
      continue;
    }
    if (c === '$' && c1 === '(') {
      const e = matchParen(src, i + 1);
      addSub(t, src.slice(i + 2, e));
      addPlain(t, '$(…)');
      i = e + 1;
      continue;
    }
    if (c === '`') {
      // PowerShell 줄 잇기
      if (c1 === '\n' || (c1 === '\r' && src.charAt(i + 2) === '\n')) {
        i += c1 === '\n' ? 2 : 3;
        continue;
      }
      const e = src.indexOf('`', i + 1);
      addSub(t, src.slice(i + 1, e < 0 ? n : e));
      addPlain(t, '`…`');
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '\\' && i + 1 < n) {
      if (c1 === '\n') {
        i += 2;
        continue;
      }
      if (c1 === '\r' && src.charAt(i + 2) === '\n') {
        i += 3;
        continue;
      }
      // 백슬래시는 남겨요(따옴표 없는 Windows 경로)
      addPlain(t, c + c1);
      i += 2;
      continue;
    }
    if (c === '>' || c === '<') {
      // 리다이렉션: 연산자는 따로, 대상은 다음 낱말
      let op = '';
      if (t.w && !t.w.q && t.w.v.length === 1 && isDigit(t.w.v)) {
        op = t.w.v;
        t.w = undefined;
      }
      flushWord(t);
      let j = i;
      while (j < n && op.length < 4) {
        const d = src.charAt(j);
        if (d === '<' || d === '>' || d === '&' || isDigit(d)) {
          op += d;
          j++;
        } else break;
      }
      if ((op === '<' || op === '>') && src.charAt(j) === '(') {
        // 프로세스 치환 <(…) >(…)
        const e = matchParen(src, j);
        addSub(t, src.slice(j + 1, e));
        addPlain(t, op + '(…)');
        i = e + 1;
        continue;
      }
      pushRedir(t, op);
      i = j;
      continue;
    }
    // 맨 글자는 다음 특수 글자까지 한 번에 붙여요
    let j = i + 1;
    while (j < n && !SPECIAL.has(src.charAt(j))) j++;
    addPlain(t, src.slice(i, j));
    i = j;
  }
  flushCmd(t);
  // 리다이렉션 대상 낱말을 연산자에 묶어요(명령 인자로 세지 않게)
  for (const cmd of t.cmds) {
    const out: Word[] = [];
    const ws = cmd.words;
    for (let k = 0; k < ws.length; k++) {
      const w = ws[k]!;
      const last = w.v.charAt(w.v.length - 1);
      if (w.redir && w.v !== '<<' && (last === '<' || last === '>')) {
        const next = ws[k + 1];
        if (next && !next.redir) {
          out.push({ ...w, target: next.v });
          k++;
          continue;
        }
      }
      out.push(w);
    }
    cmd.words = out;
  }
  return t.cmds;
}

// ---- 명령어 자리 찾기

interface Ctx {
  out: AgentCliCall[];
  work: number;
  scans: number;
}

interface VarVal {
  value: string;
  /** PowerShell 대입($x = …) — & 로 부를 때만 실행이에요 */
  ps: boolean;
}

const lead = (t: Word): string => (t.q ? t.lead : t.v);
const joinWords = (ws: readonly Word[]): string => ws.map((x) => x.v).join(' ');
const isFlag = (v: string): boolean => v.length > 1 && v.charAt(0) === '-';

/** bash -c · -lc · -ec … (소문자 묶음 플래그에 c가 있어요) */
function isShellCFlag(v: string): boolean {
  if (v.length < 2 || v.charAt(0) !== '-') return false;
  let hasC = false;
  for (let i = 1; i < v.length; i++) {
    const c = v.charAt(i);
    if (c < 'a' || c > 'z') return false;
    if (c === 'c') hasC = true;
  }
  return hasC;
}

function oneOf(v: string, list: readonly string[], ci = false): boolean {
  const x = ci ? v.toLowerCase() : v;
  return list.includes(x);
}

function resolveCmd(cmd: SimpleCmd, depth: number, ctx: Ctx, vars: Map<string, VarVal>): void {
  let ws = cmd.words.filter((t) => !t.redir);
  if (!ws.length) return;
  // 대입만 있는 명령은 기억해요(G="…/grok.exe" 다음 "$G" -p …)
  if (ws.every((t) => assignName(lead(t)) !== undefined)) {
    for (const t of ws) {
      const a = assignName(lead(t));
      if (a) vars.set(a.name, { value: t.v.slice(t.v.indexOf('=') + 1), ps: a.ps });
    }
    return;
  }
  const w0 = ws[0]!;
  const w1 = ws[1];
  if (!w0.q && w1 && !w1.q && w1.v === '=' && w0.v.charAt(0) === '$') {
    // PowerShell $x = … 문장
    const name = varRef(w0.v);
    const w2 = ws[2];
    if (name && w2 && ws.length === 3) vars.set(name, { value: w2.v, ps: true });
    return;
  }
  let k = 0;
  let guard = 0;
  while (k < ws.length && guard++ < MAX_UNWRAP) {
    const t = ws[k]!;
    const v = t.v;
    const ld = lead(t);
    const asg = assignName(ld);
    if (asg && !asg.ps) {
      k++; // VAR=x cmd …
      continue;
    }
    if (asg && asg.ps) return; // PowerShell $x="…" 문장
    if (!t.q && v.toLowerCase().startsWith('$env:')) return; // $env:X = … 문장
    if (!t.q && v.charAt(0) === '$' && ws[k + 1]?.v === '=') return;
    if (!t.q && KEYWORDS.has(v)) {
      k++;
      continue;
    }
    const b = baseName(v);
    if (b === 'env') {
      k++;
      while (k < ws.length) {
        const x = ws[k]!.v;
        if (isFlag(x)) {
          if (x === '-u' || x === '-C' || x === '-S') k++;
          k++;
          continue;
        }
        if (assignName(x)) {
          k++;
          continue;
        }
        break;
      }
      continue;
    }
    if (PLAIN_WRAPPERS.has(b)) {
      k++;
      while (k < ws.length && isFlag(ws[k]!.v)) {
        if (oneOf(ws[k]!.v, ['-n', '-u', '-g'])) k++;
        k++;
      }
      continue;
    }
    if (b === 'timeout' || b === 'gtimeout') {
      k++;
      while (k < ws.length && isFlag(ws[k]!.v)) {
        if (oneOf(ws[k]!.v, ['-s', '-k'])) k++;
        k++;
      }
      k++; // DURATION
      continue;
    }
    if (b === 'command') {
      const nx = ws[k + 1]?.v;
      if (nx === '-v' || nx === '-V') return; // 찾아보기
      k++;
      continue;
    }
    if (b === 'npx' || b === 'bunx' || b === 'pnpx') {
      k++;
      while (k < ws.length && isFlag(ws[k]!.v)) {
        if (oneOf(ws[k]!.v, ['-p', '--package'])) k++;
        k++;
      }
      continue;
    }
    if ((b === 'pnpm' || b === 'yarn' || b === 'bun') && oneOf(ws[k + 1]?.v ?? '', ['dlx', 'exec', 'x'])) {
      k += 2;
      continue;
    }
    if (b === 'xargs') {
      k++;
      while (k < ws.length && isFlag(ws[k]!.v)) {
        if (oneOf(ws[k]!.v, ['-I', '-n', '-L', '-P', '-d'])) k++;
        k++;
      }
      continue;
    }
    if (b === 'wsl') {
      k++;
      while (k < ws.length && isFlag(ws[k]!.v) && !oneOf(ws[k]!.v, ['--', '-e', '--exec'])) {
        if (oneOf(ws[k]!.v, ['-d', '--distribution', '-u', '--user', '--cd'])) k++;
        k++;
      }
      if (k < ws.length && oneOf(ws[k]!.v, ['--', '-e', '--exec'])) k++;
      continue;
    }
    if (b === 'start-process' || b === 'saps' || b === 'start') {
      // Start-Process [-FilePath] X [-ArgumentList …] · cmd start ["title"] [/b] X
      k++;
      let file: Word | undefined;
      let rest: Word[] = [];
      while (k < ws.length) {
        const f = ws[k]!.v.toLowerCase();
        if (f === '-filepath') {
          file = ws[k + 1];
          k += 2;
          continue;
        }
        if (f === '-argumentlist') {
          rest = ws.slice(k + 1).filter((x) => !oneOf(x.v, ['-wait', '-nonewwindow', '-passthru'], true) && !x.v.toLowerCase().startsWith('-redirectstandard'));
          break;
        }
        if (f.charAt(0) === '-' || f.charAt(0) === '/') {
          if (oneOf(f, ['-windowstyle', '-workingdirectory']) || f.startsWith('-redirectstandard')) k++;
          k++;
          continue;
        }
        if (!file) file = ws[k];
        k++;
      }
      if (!file) return;
      let args: Word[] = rest;
      const only = rest[0];
      if (rest.length === 1 && only) {
        // ArgumentList는 흔히 문자열 하나(쉼표 구분)
        const s = only.v.split(',').join(' ');
        ctx.work += s.length;
        if (ctx.work > MAX_WORK || ++ctx.scans > MAX_SCANS) return;
        args = tokenize(s).flatMap((c) => c.words.filter((x) => !x.redir));
      }
      ws = [file, ...args];
      k = 0;
      continue;
    }
    if (b === 'cmd') {
      const idx = ws.findIndex((x, j) => j > k && oneOf(x.v, ['/c', '/k'], true));
      if (idx >= 0) scan(joinWords(ws.slice(idx + 1)), depth + 1, ctx);
      return;
    }
    if (SHELLS.has(b)) {
      // 옵션 뒤 -c 문자열이면 그걸, 스크립트 인자 없이 heredoc·<<< 로 받으면 그 본문을 봐요(bash script.sh 는 못 봐요)
      for (let j = k + 1; j < ws.length; j++) {
        const x = ws[j]!.v;
        if (!isFlag(x) && !(x.length > 1 && x.charAt(0) === '+')) return;
        if (isShellCFlag(x)) {
          const s = ws[j + 1];
          if (s) scan(s.v, depth + 1, ctx);
          return;
        }
        if (x === '-o' || x === '+o' || x === '-O' || x === '+O') j++;
      }
      for (const h of cmd.heredocs) scan(h, depth + 1, ctx);
      for (const r of cmd.words) if (r.redir && r.v === '<<<' && r.target !== undefined) scan(r.target, depth + 1, ctx);
      return;
    }
    if (PWSH.has(b)) {
      const ci = ws.findIndex((x, j) => j > k && oneOf(x.v, ['-c', '-command'], true));
      if (ci > 0) scan(joinWords(ws.slice(ci + 1)), depth + 1, ctx);
      return;
    }
    if (b === 'ssh') {
      // ssh [opts] host [command…]
      let j = k + 1;
      while (j < ws.length && isFlag(ws[j]!.v)) {
        const x = ws[j]!.v;
        if (x.length === 2 && 'bcDEeFIiJLlmOopQRSWw'.includes(x.charAt(1))) j++;
        j++;
      }
      j++;
      if (j < ws.length) scan(joinWords(ws.slice(j)), depth + 1, ctx);
      return;
    }
    break;
  }
  if (k >= ws.length || guard > MAX_UNWRAP) return;
  let word = ws[k]!.v;
  const ref = varRef(word);
  if (ref !== undefined) {
    const val = vars.get(ref);
    if (!val || (val.ps && !cmd.call)) return;
    word = val.value;
  }
  const b = baseName(word);
  if (!CLIS.has(b)) return;
  const call = classify(b as AgentCli, ws.slice(k + 1).map((x) => x.v));
  if (call && ctx.out.length < AGENT_CLI_MAX_CALLS) ctx.out.push(call);
}

/** CLI 인자 훑기 — 일을 시키는 호출이면 {cli, model?, effort?}, 확인 호출이면 undefined */
function classify(cli: AgentCli, args: readonly string[]): AgentCliCall | undefined {
  const spec = SPECS[cli];
  let agent = false;
  let positional = false;
  let model: string | undefined;
  let effort: string | undefined;
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (a === '--') {
      if (j + 1 < args.length) positional = true;
      break;
    }
    if (isFlag(a)) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      const inline = eq > 0 ? a.slice(eq + 1) : undefined;
      const val = (): string | undefined => (inline !== undefined ? inline : args[++j]);
      if (HELP_FLAGS.has(name)) return undefined;
      if (spec.prompt.has(name)) agent = true;
      if (spec.model.has(name)) {
        model = val();
        continue;
      }
      if (spec.effort.has(name)) {
        effort = val();
        continue;
      }
      if (spec.config.has(name)) {
        // -c key=value (codex) — model · model_reasoning_effort
        const kv = val() ?? '';
        const e = kv.indexOf('=');
        if (e > 0) {
          const key = kv.slice(0, e).trim();
          const value = unquote(kv.slice(e + 1));
          if (key === 'model') model = value;
          else if (key === 'model_reasoning_effort') effort = value;
        }
        continue;
      }
      if (inline === undefined && spec.valued.has(name)) j++;
      continue;
    }
    if (a === '-') continue; // 표준 입력
    if (!agent && !positional) {
      // 첫 위치 인자 = 하위 명령 자리
      if (spec.meta.has(a)) return undefined;
      if (spec.agentSubs.has(a)) {
        agent = true;
        continue;
      }
    }
    positional = true;
  }
  if (positional) agent = true; // 위치 인자 프롬프트(대화형·headless)
  if (!agent && args.length === 0) agent = true; // 맨 `claude`·`codex` = 대화형 세션
  if (!agent) return undefined;
  const call: AgentCliCall = { cli };
  if (modelOk(model)) call.model = model;
  const eff = effortOf(effort);
  if (eff) call.effort = eff;
  return call;
}

function scan(src: string, depth: number, ctx: Ctx): void {
  if (depth > MAX_DEPTH || !src || ctx.out.length >= AGENT_CLI_MAX_CALLS) return;
  ctx.work += src.length;
  if (ctx.work > MAX_WORK || ++ctx.scans > MAX_SCANS) return;
  const cmds = tokenize(src);
  const vars = new Map<string, VarVal>();
  for (const c of cmds) {
    if (ctx.out.length >= AGENT_CLI_MAX_CALLS) return;
    for (const s of c.subs) scan(s, depth + 1, ctx);
    resolveCmd(c, depth, ctx, vars);
  }
}

/**
 * 명령(Bash·PowerShell 도구 input.command) 하나 안의 에이전트 CLI 호출을 명령 순서대로 돌려줘요.
 * 일을 시키는 호출만(확인·찾아보기·문자열 속 언급은 빼요), 최대 AGENT_CLI_MAX_CALLS개. 어떤 입력에도 throw하지 않아요.
 */
export function detectAgentCliCalls(command: string): AgentCliCall[] {
  try {
    if (typeof command !== 'string' || !command) return [];
    const src = command.length > AGENT_CLI_MAX_INPUT ? command.slice(0, AGENT_CLI_MAX_INPUT) : command;
    const ctx: Ctx = { out: [], work: 0, scans: 0 };
    scan(src, 0, ctx);
    return ctx.out;
  } catch {
    return [];
  }
}
