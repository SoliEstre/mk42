// Node 전용: 파이프 서버 인증 — 예측 가능한 파이프 이름을 다른 프로세스가 먼저 차지(squatting)해도 창이 믿지 않게.
// 데몬은 <home>/auth.secret(32바이트)을 알고, 창은 연결마다 새 challenge를 보내 HMAC proof를 받아 확인해요.
//   proof = base64url(HMAC-SHA256(secret, "m42d-hello-v1\n" + canonicalPipeName(pipe) + "\n" + challenge))
//
// Windows: 비밀이 "본인만" 읽을 수 있다는 걸 파일을 쓰기 전에 보장하고, 읽을 때마다 확인해요.
//   - 데몬: home 폴더를 먼저 조여요(상속 끊기, 본인·SYSTEM·Administrators만, (OI)(CI)) → 그 안에서 임시 파일을 쓰고
//     hard link로 제자리에 놓아요(빈 파일·넓은 ACL 상태로 존재하는 순간이 없어요). 조이지 못하면 시작하지 않아요.
//     home이 넓었으면(이미 새어 나갔을 수 있으니) 비밀을 새로 만들어요. 파일 ACL·소유자가 틀려도 새로 만들어요.
//   - 창(클라이언트)·두 번째 실행: home과 auth.secret 둘 다 소유자 = 현재 사용자(또는 SYSTEM·Administrators),
//     DACL에 다른 주체의 허용 ACE가 없어야 읽어요. 아니면 거부해요.
//   ACL은 언어와 상관없이 SID로 봐요(PowerShell로 SDDL을 읽고, icacls에는 *SID로 넘겨요).
import { execFile } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp, type BigIntStats } from 'node:fs';
import { join } from 'node:path';

export const AUTH_SECRET_FILE = 'auth.secret';
export const AUTH_SECRET_BYTES = 32;
export const AUTH_CHALLENGE_BYTES = 32;
export const HELLO_PROOF_CONTEXT = 'm42d-hello-v1';

/** base64url(32바이트) = 패딩 없는 43자 */
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

export class AuthSecretError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthSecretError';
    this.code = code;
  }
}

export function authSecretPath(home: string): string {
  return join(home, AUTH_SECRET_FILE);
}

/** 연결마다 새로 만드는 challenge (base64url, 32 랜덤 바이트) */
export function newChallenge(): string {
  return randomBytes(AUTH_CHALLENGE_BYTES).toString('base64url');
}

export function isValidChallenge(v: unknown): v is string {
  return typeof v === 'string' && B64URL_32.test(v);
}

/** Windows 파이프 이름은 대소문자를 가리지 않고 `/`도 받아요 — 양쪽이 같은 문자열로 서명하게 맞춰요. */
export function canonicalPipeName(pipeName: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? pipeName.replace(/\//g, '\\').toLowerCase() : pipeName;
}

export function computeProof(
  secret: Uint8Array,
  pipeName: string,
  challenge: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return createHmac('sha256', secret)
    .update(`${HELLO_PROOF_CONTEXT}\n${canonicalPipeName(pipeName, platform)}\n${challenge}`, 'utf8')
    .digest('base64url');
}

/** 상수 시간 비교. 모양이 틀린 proof·challenge는 false */
export function verifyProof(
  secret: Uint8Array,
  pipeName: string,
  challenge: string,
  proof: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isValidChallenge(challenge) || typeof proof !== 'string' || !B64URL_32.test(proof)) return false;
  if (secret.length !== AUTH_SECRET_BYTES) return false;
  const expected = Buffer.from(computeProof(secret, pipeName, challenge, platform), 'base64url');
  const got = Buffer.from(proof, 'base64url');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ───────────────────────── Windows ACL (SDDL) ─────────────────────────

export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINISTRATORS = 'S-1-5-32-544';
const SID_CREATOR_OWNER = 'S-1-3-0';
const SID_OWNER_RIGHTS = 'S-1-3-4';

/** SDDL 두 글자 별칭 → SID (icacls *SID로 지우려면 실제 SID가 필요해요) */
const SDDL_ALIASES: Readonly<Record<string, string>> = {
  SY: SID_SYSTEM,
  BA: SID_ADMINISTRATORS,
  CO: SID_CREATOR_OWNER,
  OW: SID_OWNER_RIGHTS,
  CG: 'S-1-3-1',
  WD: 'S-1-1-0',
  AU: 'S-1-5-11',
  BU: 'S-1-5-32-545',
  BG: 'S-1-5-32-546',
  PU: 'S-1-5-32-547',
  BO: 'S-1-5-32-551',
  RD: 'S-1-5-32-555',
  IU: 'S-1-5-4',
  SU: 'S-1-5-6',
  NU: 'S-1-5-2',
  AN: 'S-1-5-7',
  PS: 'S-1-5-10',
  RC: 'S-1-5-12',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  AC: 'S-1-15-2-1',
};

function resolveSid(s: string): string {
  return SDDL_ALIASES[s] ?? s;
}

export interface SddlAce {
  /** A(허용)·D(거부)·OA·XA… */
  type: string;
  flags: string;
  rights: string;
  /** 별칭은 SID로 풀어서 */
  sid: string;
}

export interface ParsedSddl {
  owner: string | undefined;
  /** null = DACL 없음(NULL DACL — 모두에게 모든 권한) */
  dacl: SddlAce[] | null;
  daclFlags: string;
}

/** 최상위(괄호 밖) 섹션 O: G: D: S: 로 나눠요. 조건부 ACE의 중첩 괄호도 견뎌요. 모양이 틀리면 throw */
export function parseSddl(sddl: string): ParsedSddl {
  const sections = new Map<string, string>();
  let cur: string | undefined;
  let start = 0;
  let depth = 0;
  for (let i = 0; i < sddl.length; i++) {
    const ch = sddl[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) throw new Error(`malformed SDDL (unbalanced): ${sddl}`);
    } else if (depth === 0 && sddl[i + 1] === ':' && 'OGDS'.includes(ch)) {
      if (cur !== undefined) sections.set(cur, sddl.slice(start, i));
      cur = ch;
      start = i + 2;
      i++;
    }
  }
  if (depth !== 0) throw new Error(`malformed SDDL (unbalanced): ${sddl}`);
  if (cur !== undefined) sections.set(cur, sddl.slice(start));
  else if (sddl.trim() !== '') throw new Error(`malformed SDDL: ${sddl}`);

  const ownerRaw = sections.get('O');
  const owner = ownerRaw ? resolveSid(ownerRaw.trim()) : undefined;
  const d = sections.get('D');
  if (d === undefined || d.includes('NO_ACCESS_CONTROL')) return { owner, dacl: null, daclFlags: '' };
  const firstParen = d.indexOf('(');
  const daclFlags = firstParen < 0 ? d : d.slice(0, firstParen);
  const dacl: SddlAce[] = [];
  let i = firstParen < 0 ? d.length : firstParen;
  while (i < d.length) {
    if (d[i] !== '(') throw new Error(`malformed SDDL ACE list: ${d}`);
    let j = i + 1;
    let dep = 1;
    const fields: string[] = [];
    let fieldStart = j;
    for (; j < d.length && dep > 0; j++) {
      const ch = d[j];
      if (ch === '(') dep++;
      else if (ch === ')') {
        dep--;
        if (dep === 0) break;
      } else if (ch === ';' && dep === 1) {
        fields.push(d.slice(fieldStart, j));
        fieldStart = j + 1;
      }
    }
    if (dep !== 0) throw new Error(`malformed SDDL ACE: ${d}`);
    fields.push(d.slice(fieldStart, j));
    if (fields.length < 6) throw new Error(`malformed SDDL ACE: ${d.slice(i, j + 1)}`);
    dacl.push({ type: fields[0]!, flags: fields[1]!, rights: fields[2]!, sid: resolveSid(fields[5]!.trim()) });
    i = j + 1;
  }
  return { owner, dacl, daclFlags };
}

const DENY_ACE_TYPES = new Set(['D', 'OD', 'XD']);

export interface AclVerdict {
  ok: boolean;
  /** 소유자가 현재 사용자·SYSTEM·Administrators가 아니에요 */
  badOwner: boolean;
  problems: string[];
  /** 상속이 아닌(명시적) 다른 주체 허용 ACE의 SID — 조일 때 /remove:g로 지워요 */
  explicitForeignSids: string[];
}

/**
 * "본인 전용"인지: 소유자 ∈ {현재 사용자, SYSTEM, Administrators}, DACL이 있고, 허용 ACE는
 * {현재 사용자, SYSTEM, Administrators, CREATOR OWNER, OWNER RIGHTS}에만. 읽기 권한 하나라도 다른 주체에 있으면 실패예요.
 */
export function checkPrivateAcl(sddl: string, userSid: string): AclVerdict {
  const problems: string[] = [];
  const explicitForeign = new Set<string>();
  let badOwner = false;
  let parsed: ParsedSddl;
  try {
    parsed = parseSddl(sddl);
  } catch (e) {
    return { ok: false, badOwner: false, problems: [errMsg(e)], explicitForeignSids: [] };
  }
  const trustedOwners = new Set([userSid, SID_SYSTEM, SID_ADMINISTRATORS]);
  if (!parsed.owner || !trustedOwners.has(parsed.owner)) {
    badOwner = true;
    problems.push(`owner ${parsed.owner ?? '(none)'} is not the current user ${userSid}`);
  }
  if (parsed.dacl === null) {
    problems.push('no DACL (everyone has full access)');
  } else {
    const trustedTrustees = new Set([userSid, SID_SYSTEM, SID_ADMINISTRATORS, SID_CREATOR_OWNER, SID_OWNER_RIGHTS]);
    for (const ace of parsed.dacl) {
      if (DENY_ACE_TYPES.has(ace.type)) continue;
      if (trustedTrustees.has(ace.sid)) continue;
      const inherited = ace.flags.includes('ID');
      problems.push(`grants ${ace.rights || '?'} to ${ace.sid}${inherited ? ' (inherited)' : ''}`);
      if (!inherited) explicitForeign.add(ace.sid);
    }
  }
  return { ok: problems.length === 0, badOwner, problems, explicitForeignSids: [...explicitForeign] };
}

export interface AclSnapshot {
  /** 현재 프로세스 사용자 SID */
  userSid: string;
  /** paths와 같은 순서의 SDDL(Owner + DACL) */
  sddl: string[];
}

/** Windows ACL 조작 — 테스트에서 바꿔 끼워요. */
export interface WinAclOps {
  inspect(paths: readonly string[]): Promise<AclSnapshot>;
  /** 상속을 끊고 본인·SYSTEM·Administrators만 F, removeSids의 명시적 허용 ACE는 지워요. */
  tighten(path: string, isDir: boolean, userSid: string, removeSids: readonly string[]): Promise<void>;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { windowsHide: boolean; timeout: number; shell: false; env?: NodeJS.ProcessEnv; maxBuffer?: number },
  cb: (err: Error | null, stdout?: string | Buffer, stderr?: string | Buffer) => void,
) => unknown;

const defaultRun = execFile as unknown as ExecFileLike;

function system32(env: NodeJS.ProcessEnv): string {
  return join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32');
}

/** 경로 목록은 환경 변수(줄바꿈 구분 — Windows 경로에 못 들어가는 문자)로, 스크립트는 -EncodedCommand로 넘겨요(셸·따옴표 해석 없음). */
const INSPECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '  $out = New-Object System.Collections.Generic.List[string]',
  '  $out.Add([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)',
  '  foreach ($p in $env:M42_ACL_PATHS.Split([char]10)) {',
  "    $sec = [System.Security.AccessControl.AccessControlSections]'Owner,Access'",
  '    if ([System.IO.Directory]::Exists($p)) { $s = [System.IO.Directory]::GetAccessControl($p, $sec) }',
  '    else { $s = [System.IO.File]::GetAccessControl($p, $sec) }',
  '    $out.Add($s.GetSecurityDescriptorSddlForm($sec))',
  '  }',
  '  [Console]::Out.Write(($out -join [string][char]10))',
  '} catch {',
  '  [Console]::Error.Write($_.Exception.Message)',
  '  exit 3',
  '}',
].join('\n');

export function inspectArgs(paths: readonly string[], env: NodeJS.ProcessEnv = process.env): { exe: string; args: string[]; env: NodeJS.ProcessEnv } {
  for (const p of paths) {
    if (p.includes('\n') || p.includes('\r')) throw new AuthSecretError('EINVAL', `path contains a line break: ${JSON.stringify(p)}`);
  }
  return {
    exe: join(system32(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(INSPECT_SCRIPT, 'utf16le').toString('base64')],
    env: { ...env, M42_ACL_PATHS: paths.join('\n') },
  };
}

export function parseInspectOutput(stdout: string, count: number): AclSnapshot {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const userSid = lines[0];
  if (!userSid || !/^S-1-\d+(-\d+)+$/.test(userSid)) throw new Error(`unexpected ACL inspection output (no user SID): ${stdout.slice(0, 200)}`);
  const sddl = lines.slice(1);
  if (sddl.length !== count) throw new Error(`unexpected ACL inspection output (${sddl.length} descriptors for ${count} paths)`);
  return { userSid, sddl };
}

export function inspectAclWindows(paths: readonly string[], run: ExecFileLike = defaultRun): Promise<AclSnapshot> {
  const { exe, args, env } = inspectArgs(paths);
  return new Promise((resolve, reject) => {
    run(exe, args, { windowsHide: true, timeout: 30_000, shell: false, env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr ? String(stderr).trim() : '';
        reject(new Error(`ACL inspection failed: ${err.message}${detail ? ` — ${detail}` : ''}`));
        return;
      }
      try {
        resolve(parseInspectOutput(String(stdout ?? ''), paths.length));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** icacls "<path>" /inheritance:r /grant:r *<user>:F *SYSTEM:F *Administrators:F [/remove:g *<sid>…] — 계정 이름 대신 SID라 이름 해석 실패가 없어요. */
export function icaclsArgs(
  path: string,
  isDir: boolean,
  userSid: string,
  removeSids: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): { exe: string; args: string[] } {
  const inh = isDir ? '(OI)(CI)' : '';
  const sid = /^S-1-\d+(-\d+)+$/;
  for (const s of [userSid, ...removeSids]) {
    if (!sid.test(s)) throw new AuthSecretError('EACL', `cannot pass non-SID principal to icacls: ${s}`);
  }
  const args = [path, '/inheritance:r', '/grant:r', `*${userSid}:${inh}F`, `*${SID_SYSTEM}:${inh}F`, `*${SID_ADMINISTRATORS}:${inh}F`];
  const extra = removeSids.filter((s) => s !== userSid && s !== SID_SYSTEM && s !== SID_ADMINISTRATORS);
  if (extra.length > 0) args.push('/remove:g', ...extra.map((s) => `*${s}`));
  args.push('/q');
  return { exe: join(system32(env), 'icacls.exe'), args };
}

export function tightenAclWindows(
  path: string,
  isDir: boolean,
  userSid: string,
  removeSids: readonly string[] = [],
  run: ExecFileLike = defaultRun,
): Promise<void> {
  let cmd: { exe: string; args: string[] };
  try {
    cmd = icaclsArgs(path, isDir, userSid, removeSids);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    run(cmd.exe, cmd.args, { windowsHide: true, timeout: 30_000, shell: false }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`icacls failed: ${err.message}${stderr ? ` — ${String(stderr).trim()}` : ''}`));
      else resolve();
    });
  });
}

export const windowsAcl: WinAclOps = {
  inspect: (paths) => inspectAclWindows(paths),
  tighten: (path, isDir, userSid, removeSids) => tightenAclWindows(path, isDir, userSid, removeSids),
};

function aclError(what: string, path: string, v: AclVerdict): AuthSecretError {
  return new AuthSecretError(
    v.badOwner ? 'EOWNER' : 'EACL',
    `${what} is not private to the current user (${v.problems.join('; ')}): ${path}`,
  );
}

async function inspectOrThrow(ops: WinAclOps, paths: readonly string[]): Promise<AclSnapshot> {
  try {
    const snap = await ops.inspect(paths);
    if (snap.sddl.length !== paths.length) throw new Error(`ACL inspection returned ${snap.sddl.length} descriptors for ${paths.length} paths`);
    return snap;
  } catch (e) {
    if (e instanceof AuthSecretError) throw e;
    throw new AuthSecretError('EACLCHECK', `cannot verify ACL of ${paths.join(', ')}: ${errMsg(e)}`);
  }
}

export type AuthLog = (level: 'info' | 'warn', msg: string) => void;

export interface PrivateDirResult {
  /** 넓어서 조였어요(그 안에 있던 비밀은 이미 새어 나갔을 수 있어요) */
  tightened: boolean;
  /** 처음 검사를 시작한 시각(ms) — 이 뒤에 생긴 파일은 조인 폴더 안에서 생겼어요 */
  checkedAt: number;
}

/**
 * Windows: dir가 본인 전용이 되게 해요 — 검사 → 넓으면 조이기 → 다시 검사. 소유자가 남이면 손대지 않고 EOWNER,
 * 조인 뒤에도 넓으면 EACL, 검사 자체가 안 되면 EACLCHECK(모두 치명적). 다른 플랫폼에서는 아무것도 안 해요.
 */
export async function ensurePrivateDir(
  dir: string,
  opts: { platform?: NodeJS.Platform; winAcl?: WinAclOps; log?: AuthLog } = {},
): Promise<PrivateDirResult> {
  const checkedAt = Date.now();
  const created = await fsp.mkdir(dir, { recursive: true });
  if ((opts.platform ?? process.platform) !== 'win32') return { tightened: false, checkedAt };
  const ops = opts.winAcl ?? windowsAcl;
  const snap = await inspectOrThrow(ops, [dir]);
  const v = checkPrivateAcl(snap.sddl[0]!, snap.userSid);
  if (v.ok) return { tightened: false, checkedAt };
  if (v.badOwner) throw aclError('Mark42 home folder', dir, v);
  opts.log?.(created ? 'info' : 'warn', `Mark42 home folder ACL is too broad (${v.problems.join('; ')}) — restricting to the current user, SYSTEM and Administrators: ${dir}`);
  try {
    await ops.tighten(dir, true, snap.userSid, v.explicitForeignSids);
  } catch (e) {
    throw new AuthSecretError('EACL', `cannot restrict ACL of Mark42 home folder ${dir}: ${errMsg(e)}`);
  }
  const again = await inspectOrThrow(ops, [dir]);
  const v2 = checkPrivateAcl(again.sddl[0]!, again.userSid);
  if (!v2.ok) throw aclError('Mark42 home folder (after restricting)', dir, v2);
  return { tightened: true, checkedAt };
}

// ───────────────────────── 읽기 ─────────────────────────

interface ReadOptions {
  platform: NodeJS.Platform;
  /** 데몬: POSIX에서 권한이 넓으면 0600으로 줄여요. 창: 넓으면 거부해요. */
  fixMode: boolean;
  /** Windows: 검사할 경로(파일 + 창이면 home) */
  winAcl?: { ops: WinAclOps; home?: string; cache?: Map<string, string> };
}

function statKey(s: BigIntStats): string {
  return `${s.dev}:${s.ino}:${s.ctimeNs}:${s.mtimeNs}:${s.size}`;
}

/** 기본 검사기로 통과한 (home, 파일) — 둘의 ino·ctime(ACL을 바꾸면 바뀌어요)·mtime이 그대로면 다시 PowerShell을 띄우지 않아요. */
const verifiedAclCache = new Map<string, string>();

async function readSecretFile(file: string, o: ReadOptions): Promise<Buffer> {
  let st;
  try {
    st = await fsp.lstat(file, { bigint: true });
  } catch (e) {
    throw new AuthSecretError(errCode(e) ?? 'EIO', `auth secret unavailable: ${file} (${errCode(e) ?? String(e)})`);
  }
  if (!st.isFile()) throw new AuthSecretError('ENOTFILE', `auth secret is not a regular file: ${file}`);
  if (o.platform !== 'win32') {
    if (typeof process.getuid === 'function' && Number(st.uid) !== process.getuid()) {
      throw new AuthSecretError('EOWNER', `auth secret is owned by another user: ${file}`);
    }
    if ((Number(st.mode) & 0o077) !== 0) {
      if (!o.fixMode) throw new AuthSecretError('EMODE', `auth secret is readable by others (mode ${(Number(st.mode) & 0o777).toString(8)}): ${file}`);
      await fsp.chmod(file, 0o600);
    }
  } else if (o.winAcl) {
    const { ops, home, cache } = o.winAcl;
    const paths = home ? [home, file] : [file];
    let key: string | undefined;
    if (cache) {
      const hs = home ? await fsp.stat(home, { bigint: true }) : undefined;
      key = `${hs ? statKey(hs) : ''}|${statKey(st)}`;
    }
    if (!(cache && key !== undefined && cache.get(paths.join('\n')) === key)) {
      const snap = await inspectOrThrow(ops, paths);
      for (let i = 0; i < paths.length; i++) {
        const v = checkPrivateAcl(snap.sddl[i]!, snap.userSid);
        if (!v.ok) throw aclError(paths[i] === file ? 'auth secret' : 'Mark42 home folder', paths[i]!, v);
      }
      if (cache && key !== undefined) cache.set(paths.join('\n'), key);
    }
  }
  const buf = await fsp.readFile(file);
  if (buf.length !== AUTH_SECRET_BYTES) {
    throw new AuthSecretError('EINVAL', `auth secret has wrong length ${buf.length} (want ${AUTH_SECRET_BYTES}): ${file}`);
  }
  return buf;
}

export interface ReadAuthSecretOptions {
  platform?: NodeJS.Platform;
  /** Windows ACL 검사기(기본: PowerShell로 SDDL 읽기 — 통과 결과는 파일·폴더가 바뀌기 전까지 기억해요) */
  winAcl?: WinAclOps;
}

/**
 * 창(클라이언트)·두 번째 실행: 읽기만 해요. 없거나 모양이 틀리면 AuthSecretError.
 * Windows에서는 home과 auth.secret 둘 다 본인 전용(소유자·DACL)이어야 해요 — 아니면 EOWNER/EACL, 검사가 안 되면 EACLCHECK.
 */
export function readAuthSecret(home: string, opts: ReadAuthSecretOptions = {}): Promise<Buffer> {
  const platform = opts.platform ?? process.platform;
  const ops = opts.winAcl ?? windowsAcl;
  return readSecretFile(authSecretPath(home), {
    platform,
    fixMode: false,
    winAcl: { ops, home, ...(ops === windowsAcl ? { cache: verifiedAclCache } : {}) },
  });
}

// ───────────────────────── 데몬: 읽거나 만들기 ─────────────────────────

export interface LoadOrCreateOptions {
  log?: AuthLog;
  platform?: NodeJS.Platform;
  /** Windows ACL 검사·조이기(기본 PowerShell + icacls). 테스트에서 바꿔 끼워요. */
  winAcl?: WinAclOps;
}

export interface LoadedSecret {
  secret: Buffer;
  created: boolean;
}

/** 임시 파일에 다 쓴 뒤 hard link로 제자리에 놓아요 — 이미 있으면 EEXIST(덮어쓰지 않아요), 빈 파일이 보이는 순간이 없어요. */
async function publishSecret(file: string, secret: Buffer): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, secret, { flag: 'wx', mode: 0o600 });
  try {
    await fsp.link(tmp, file);
    return true;
  } catch (e) {
    const code = errCode(e);
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EXDEV' && code !== 'EMLINK') throw e;
    // hard link를 못 쓰는 파일 시스템 — 배타적 생성으로(같은 비공개 폴더 안이라 ACL은 같아요)
    try {
      await fsp.writeFile(file, secret, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e2) {
      if (errCode(e2) === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

/**
 * 데몬: 있으면 읽고, 없으면 32바이트를 만들어요.
 * - 길이가 틀린(깨진) 파일이면 지우고 새로 만들어요.
 * - Windows: 파일을 만들거나 읽기 전에 home을 본인 전용으로 조여요(못 하면 시작하지 않아요).
 *   home이 넓었으면(조이기 전부터 있던) 비밀을 새로 만들고, 파일의 소유자·ACL이 틀려도 새로 만들어요.
 *   새로 만든 파일도 확인해서 본인 전용이 아니면 지우고 실패해요.
 */
export async function loadOrCreateAuthSecret(home: string, opts: LoadOrCreateOptions = {}): Promise<LoadedSecret> {
  const platform = opts.platform ?? process.platform;
  const log: AuthLog = opts.log ?? (() => {});
  const file = authSecretPath(home);
  const win = platform === 'win32';
  const ops = opts.winAcl ?? windowsAcl;
  const dir = await ensurePrivateDir(home, { platform, winAcl: ops, log });

  if (dir.tightened) {
    // 넓은 ACL 아래에서 만들어진 비밀은 이미 읽혔을 수 있어요 — 조인 뒤(검사 시작 이후)에 생긴 것만 남겨요
    try {
      const st = await fsp.lstat(file);
      if (st.isFile() && st.birthtimeMs < dir.checkedAt) {
        log('warn', `auth secret existed while the home folder ACL was broad — regenerating: ${file}`);
        await fsp.unlink(file).catch((e: unknown) => {
          if (errCode(e) !== 'ENOENT') throw e;
        });
      }
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const secret = await readSecretFile(file, { platform, fixMode: true, ...(win ? { winAcl: { ops } } : {}) });
      return { secret, created: false };
    } catch (e) {
      const code = errCode(e);
      if (code === 'EINVAL' || (win && (code === 'EACL' || code === 'EOWNER'))) {
        log('warn', `${errMsg(e)} — regenerating`);
        await fsp.unlink(file).catch(() => {});
      } else if (code !== 'ENOENT') {
        throw e;
      }
    }
    const secret = randomBytes(AUTH_SECRET_BYTES);
    if (!(await publishSecret(file, secret))) continue; // 다른 프로세스가 먼저 만들었어요 — 다시 읽어요
    if (win) {
      const snap = await inspectOrThrow(ops, [file]).catch(async (e: unknown) => {
        await fsp.unlink(file).catch(() => {});
        throw e;
      });
      const v = checkPrivateAcl(snap.sddl[0]!, snap.userSid);
      if (!v.ok) {
        await fsp.unlink(file).catch(() => {});
        throw aclError('newly created auth secret', file, v);
      }
      log('info', `auth secret created in owner-only home folder: ${file}`);
    } else {
      log('info', `auth secret created (mode 0600): ${file}`);
    }
    return { secret, created: true };
  }
  throw new AuthSecretError('EAGAIN', `could not load or create auth secret: ${file}`);
}
