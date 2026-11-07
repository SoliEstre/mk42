import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AUTH_SECRET_BYTES,
  authSecretPath,
  canonicalPipeName,
  checkPrivateAcl,
  computeProof,
  ensurePrivateDir,
  icaclsArgs,
  inspectAclWindows,
  inspectArgs,
  isValidChallenge,
  loadOrCreateAuthSecret,
  newChallenge,
  parseInspectOutput,
  parseSddl,
  readAuthSecret,
  tightenAclWindows,
  verifyProof,
  windowsAcl,
  type AuthSecretError,
  type ExecFileLike,
  type WinAclOps,
} from '../src/auth.ts';

function tmpHome(): { home: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'm42-auth-'));
  return { home: join(dir, 'home'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const code = (c: string) => (e: AuthSecretError) => e.code === c;

// ───────── 가짜 Windows ACL: 경로별 SDDL. 조이지 않은 폴더·그 안의 파일은 %LOCALAPPDATA%처럼 넓어요(샌드박스 사용자에게 RX 상속) ─────────
const USER = 'S-1-5-21-111-222-333-1001';
const SANDBOX = 'S-1-5-21-111-222-333-1003';
const OTHER = 'S-1-5-21-111-222-333-1500';
const PRIVATE_DIR = `O:${USER}G:${USER}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`;
const PRIVATE_FILE = `O:${USER}G:${USER}D:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${USER})`;
const BROAD = `O:${USER}G:${USER}D:AI(A;OICIID;0x1301bf;;;${SANDBOX})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;

interface FakeAcl extends WinAclOps {
  calls: string[];
  /** 경로별로 고정한 SDDL(조이면 지워져요) */
  fixed: Map<string, string>;
  privateDirs: Set<string>;
  failInspect?: boolean;
  failTighten?: boolean;
  /** icacls가 성공한 척하지만 바뀌지 않아요 */
  tightenNoEffect?: boolean;
  /** tighten을 부른 순간 auth.secret이 있었는지 */
  secretExistedAtTighten: boolean[];
}

function fakeAcl(init: { privateDirs?: string[]; fixed?: Record<string, string> } = {}): FakeAcl {
  const f: FakeAcl = {
    calls: [],
    fixed: new Map(Object.entries(init.fixed ?? {})),
    privateDirs: new Set(init.privateDirs ?? []),
    secretExistedAtTighten: [],
    async inspect(paths) {
      f.calls.push(`inspect ${paths.length}`);
      if (f.failInspect) throw new Error('powershell blocked');
      return {
        userSid: USER,
        sddl: paths.map((p) => f.fixed.get(p) ?? (f.privateDirs.has(p) ? PRIVATE_DIR : f.privateDirs.has(dirname(p)) ? PRIVATE_FILE : BROAD)),
      };
    },
    async tighten(path, isDir, userSid, removeSids) {
      f.calls.push(`tighten ${isDir ? 'dir' : 'file'} ${userSid} [${removeSids.join(',')}]`);
      f.secretExistedAtTighten.push(existsSync(join(path, 'auth.secret')));
      if (f.failTighten) throw new Error('icacls exploded');
      if (f.tightenNoEffect) return;
      f.fixed.delete(path);
      if (isDir) f.privateDirs.add(path);
    },
  };
  return f;
}

/** 모든 경로가 이미 본인 전용 */
const trustingAcl: WinAclOps = {
  inspect: async (paths) => ({ userSid: USER, sddl: paths.map(() => PRIVATE_FILE) }),
  tighten: async () => {
    throw new Error('should not tighten');
  },
};

// ───────── HMAC ─────────

test('challenge is base64url of 32 bytes and fresh each time', () => {
  const a = newChallenge();
  const b = newChallenge();
  assert.ok(isValidChallenge(a));
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.equal(isValidChallenge('short'), false);
  assert.equal(isValidChallenge(a + '='), false);
  assert.equal(isValidChallenge(a.slice(0, 42) + '+'), false);
  assert.equal(isValidChallenge(42), false);
});

test('proof = base64url(HMAC-SHA256(secret, "m42d-hello-v1\\n" + pipe + "\\n" + challenge))', () => {
  const secret = randomBytes(32);
  const ch = newChallenge();
  const pipe = '\\\\.\\pipe\\mark42-m42d-abc';
  const expected = createHmac('sha256', secret).update(`m42d-hello-v1\n${pipe}\n${ch}`).digest('base64url');
  assert.equal(computeProof(secret, pipe, ch, 'linux'), expected);
  assert.ok(verifyProof(secret, pipe, ch, expected, 'linux'));
});

test('verifyProof rejects wrong secret, pipe, challenge, missing or malformed proof', () => {
  const secret = randomBytes(32);
  const ch = newChallenge();
  const pipe = '\\\\.\\pipe\\p1';
  const proof = computeProof(secret, pipe, ch, 'win32');
  assert.ok(verifyProof(secret, pipe, ch, proof, 'win32'));
  assert.equal(verifyProof(randomBytes(32), pipe, ch, proof, 'win32'), false, 'wrong secret');
  assert.equal(verifyProof(secret, '\\\\.\\pipe\\p2', ch, proof, 'win32'), false, 'proof bound to the pipe name');
  assert.equal(verifyProof(secret, pipe, newChallenge(), proof, 'win32'), false, 'proof bound to the challenge');
  assert.equal(verifyProof(secret, pipe, ch, undefined, 'win32'), false);
  assert.equal(verifyProof(secret, pipe, ch, '', 'win32'), false);
  assert.equal(verifyProof(secret, pipe, ch, proof + 'A', 'win32'), false);
  assert.equal(verifyProof(secret, pipe, ch, { proof }, 'win32'), false);
  assert.equal(verifyProof(secret.subarray(0, 16), pipe, ch, proof, 'win32'), false, 'short secret');
});

test('pipe name is canonical on Windows (case, slashes) but exact elsewhere', () => {
  assert.equal(canonicalPipeName('\\\\.\\PIPE\\Mark42-X', 'win32'), '\\\\.\\pipe\\mark42-x');
  assert.equal(canonicalPipeName('//./pipe/a', 'win32'), '\\\\.\\pipe\\a');
  assert.equal(canonicalPipeName('/tmp/A.sock', 'linux'), '/tmp/A.sock');
  const s = randomBytes(32);
  const ch = newChallenge();
  assert.ok(verifyProof(s, '\\\\.\\PIPE\\D', ch, computeProof(s, '\\\\.\\pipe\\d', ch, 'win32'), 'win32'));
});

// ───────── SDDL ─────────

test('parseSddl: owner, DACL flags, aliases, inherited flags', () => {
  // 이 기계 %TEMP%에서 실제로 본 모양(샌드박스 사용자 RX·M 상속)
  const real =
    'O:S-1-5-21-1031052199-283247061-2906487634-1001G:S-1-5-21-1031052199-283247061-2906487634-1001D:AI(A;OICIID;0x1301bf;;;S-1-5-21-1031052199-283247061-2906487634-1003)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;S-1-5-21-1031052199-283247061-2906487634-1001)';
  const p = parseSddl(real);
  assert.equal(p.owner, 'S-1-5-21-1031052199-283247061-2906487634-1001');
  assert.equal(p.daclFlags, 'AI');
  assert.equal(p.dacl!.length, 4);
  assert.deepEqual(p.dacl![1], { type: 'A', flags: 'OICIID', rights: 'FA', sid: 'S-1-5-18' });
  assert.equal(p.dacl![2]!.sid, 'S-1-5-32-544');
  assert.equal(parseSddl('O:BAG:SYD:PAI(A;;FA;;;SY)').owner, 'S-1-5-32-544');
  assert.equal(parseSddl('O:SYD:(A;;FA;;;AU)').dacl![0]!.sid, 'S-1-5-11');
  assert.equal(parseSddl('O:SYG:SYD:NO_ACCESS_CONTROL').dacl, null);
  assert.equal(parseSddl('O:SYG:SY').dacl, null, 'no D: section = no DACL');
  // 조건부 ACE의 중첩 괄호
  const cond = parseSddl(`O:${USER}D:(XA;;FR;;;WD;(Member_of {SID(BA)}))(A;;FA;;;${USER})`);
  assert.equal(cond.dacl!.length, 2);
  assert.equal(cond.dacl![0]!.sid, 'S-1-1-0');
  assert.throws(() => parseSddl('O:SYD:(A;;FA'), /malformed/);
  assert.throws(() => parseSddl('O:SYD:(A;;FA;;;SY))'), /malformed/);
  assert.throws(() => parseSddl('garbage'), /malformed/);
});

test('checkPrivateAcl: only current user, SYSTEM, Administrators (owner and allow ACEs)', () => {
  assert.equal(checkPrivateAcl(PRIVATE_DIR, USER).ok, true);
  assert.equal(checkPrivateAcl(PRIVATE_FILE, USER).ok, true);
  assert.equal(checkPrivateAcl(`O:BAD:PAI(A;;FA;;;${USER})(A;OICIIO;FA;;;CO)`, USER).ok, true, 'Administrators owner, CREATOR OWNER inherit-only');
  assert.equal(checkPrivateAcl(`O:${USER}D:P(A;;FA;;;${USER})(D;;FA;;;${OTHER})`, USER).ok, true, 'deny ACEs for others are fine');

  const broad = checkPrivateAcl(BROAD, USER);
  assert.equal(broad.ok, false);
  assert.equal(broad.badOwner, false);
  assert.match(broad.problems.join(), new RegExp(`${SANDBOX} \\(inherited\\)`));
  assert.deepEqual(broad.explicitForeignSids, [], 'inherited ACEs go away with /inheritance:r');

  const explicit = checkPrivateAcl(`O:${USER}D:PAI(A;;FR;;;AU)(A;;FA;;;${USER})(A;;0x1;;;${OTHER})`, USER);
  assert.equal(explicit.ok, false);
  assert.deepEqual(explicit.explicitForeignSids.sort(), ['S-1-5-11', OTHER].sort());

  const planted = checkPrivateAcl(`O:${OTHER}D:PAI(A;;FA;;;${USER})`, USER);
  assert.equal(planted.ok, false, 'another user owns it even though the DACL looks private');
  assert.equal(planted.badOwner, true);

  assert.equal(checkPrivateAcl(`O:${USER}D:NO_ACCESS_CONTROL`, USER).ok, false, 'NULL DACL');
  assert.equal(checkPrivateAcl('not sddl', USER).ok, false, 'unparseable fails closed');
  assert.equal(checkPrivateAcl(`D:PAI(A;;FA;;;${USER})`, USER).badOwner, true, 'missing owner');
  assert.equal(checkPrivateAcl(`O:${USER}D:PAI(A;;FR;;;WD)`, USER).ok, false, 'Everyone read');
});

// ───────── 명령 인자 ─────────

test('icacls gets SIDs (*S-1-…), never account names, and no shell', async () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const dir = icaclsArgs('C:\\h', true, USER, [OTHER, 'S-1-5-11'], env);
  assert.equal(dir.exe, join('C:\\Windows', 'System32', 'icacls.exe'));
  assert.deepEqual(dir.args, [
    'C:\\h',
    '/inheritance:r',
    '/grant:r',
    `*${USER}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
    '/remove:g',
    `*${OTHER}`,
    '*S-1-5-11',
    '/q',
  ]);
  const file = icaclsArgs('C:\\h\\auth.secret', false, USER, [], env);
  assert.deepEqual(file.args, ['C:\\h\\auth.secret', '/inheritance:r', '/grant:r', `*${USER}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F', '/q']);
  assert.throws(() => icaclsArgs('C:\\h', true, 'PC\\alice'), /non-SID/);
  assert.throws(() => icaclsArgs('C:\\h', true, USER, ['XX']), /non-SID/);

  const calls: { file: string; args: readonly string[]; shell: boolean }[] = [];
  const ok: ExecFileLike = (f, a, o, cb) => {
    calls.push({ file: f, args: a, shell: o.shell });
    cb(null, '', '');
  };
  await tightenAclWindows('C:\\h', true, USER, [], ok);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.shell, false);
  assert.equal(calls[0]!.args[0], 'C:\\h');
  await assert.rejects(tightenAclWindows('x', true, USER, [], (_f, _a, _o, cb) => cb(new Error('denied'))), /icacls failed: denied/);
});

test('ACL inspection: PowerShell without shell, paths via env, SID-only output parsed strictly', async () => {
  const a = inspectArgs(['C:\\h', 'C:\\h\\auth.secret'], { SystemRoot: 'C:\\Windows' });
  assert.equal(a.exe, join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.ok(a.args.includes('-NoProfile') && a.args.includes('-NonInteractive') && a.args.includes('-EncodedCommand'));
  assert.equal(a.env.M42_ACL_PATHS, 'C:\\h\nC:\\h\\auth.secret');
  const script = Buffer.from(a.args[a.args.length - 1]!, 'base64').toString('utf16le');
  assert.match(script, /GetAccessControl/);
  assert.match(script, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
  assert.throws(() => inspectArgs(['C:\\a\nb']), /line break/);

  assert.deepEqual(parseInspectOutput(`${USER}\r\n${PRIVATE_DIR}\r\n${PRIVATE_FILE}\r\n`, 2), { userSid: USER, sddl: [PRIVATE_DIR, PRIVATE_FILE] });
  assert.throws(() => parseInspectOutput(`${USER}\n${PRIVATE_DIR}`, 2), /1 descriptors for 2/);
  assert.throws(() => parseInspectOutput('PC\\alice\nO:SY', 1), /no user SID/);

  let seen: { shell: boolean; env?: NodeJS.ProcessEnv } | undefined;
  const run: ExecFileLike = (_f, _a, o, cb) => {
    seen = { shell: o.shell, env: o.env };
    cb(null, `${USER}\n${PRIVATE_FILE}\n`, '');
  };
  assert.deepEqual(await inspectAclWindows(['C:\\x'], run), { userSid: USER, sddl: [PRIVATE_FILE] });
  assert.equal(seen!.shell, false);
  assert.equal(seen!.env!.M42_ACL_PATHS, 'C:\\x');
  await assert.rejects(inspectAclWindows(['C:\\x'], (_f, _a, _o, cb) => cb(new Error('exit 3'), '', 'access denied')), /ACL inspection failed: exit 3 — access denied/);
});

// ───────── 데몬: 읽거나 만들기 (플랫폼 기본) ─────────

test('loadOrCreateAuthSecret creates once (exclusive), then reads the same bytes', async () => {
  const t = tmpHome();
  try {
    const first = await loadOrCreateAuthSecret(t.home, { winAcl: fakeAcl() });
    assert.equal(first.created, true);
    assert.equal(first.secret.length, AUTH_SECRET_BYTES);
    assert.deepEqual(readFileSync(authSecretPath(t.home)), first.secret);
    if (process.platform !== 'win32') assert.equal(statSync(authSecretPath(t.home)).mode & 0o777, 0o600);
    const second = await loadOrCreateAuthSecret(t.home, { winAcl: trustingAcl });
    assert.equal(second.created, false);
    assert.deepEqual(second.secret, first.secret);
    assert.deepEqual(await readAuthSecret(t.home, { winAcl: trustingAcl }), first.secret);
    // 동시에 여러 번 불러도 하나만 만들어요(임시 파일 + hard link — 덮어쓰지 않아요)
    const t2 = tmpHome();
    try {
      const all = await Promise.all([1, 2, 3, 4, 5, 6].map(() => loadOrCreateAuthSecret(t2.home, { winAcl: trustingAcl })));
      assert.equal(all.filter((r) => r.created).length, 1);
      for (const r of all) assert.deepEqual(r.secret, all[0]!.secret);
      assert.deepEqual(readFileSync(authSecretPath(t2.home)), all[0]!.secret);
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

test('corrupted secret is regenerated by the daemon; the client refuses it', async () => {
  const t = tmpHome();
  try {
    mkdirSync(t.home, { recursive: true });
    writeFileSync(authSecretPath(t.home), 'short', { mode: 0o600 });
    await assert.rejects(readAuthSecret(t.home, { winAcl: trustingAcl }), /wrong length/);
    const r = await loadOrCreateAuthSecret(t.home, { winAcl: trustingAcl });
    assert.equal(r.created, true);
    assert.equal(readFileSync(authSecretPath(t.home)).length, 32);
  } finally {
    t.cleanup();
  }
});

test('readAuthSecret fails clearly when the file is missing or not a file', async () => {
  const t = tmpHome();
  try {
    await assert.rejects(readAuthSecret(t.home), (e: Error & { code?: string }) => e.code === 'ENOENT' && /auth secret unavailable/.test(e.message));
    mkdirSync(authSecretPath(t.home), { recursive: true });
    await assert.rejects(readAuthSecret(t.home), /not a regular file/);
  } finally {
    t.cleanup();
  }
});

// ───────── 데몬: Windows ACL (가짜 ACL, 진짜 파일) ─────────

test('win32: a new home is tightened BEFORE the secret is written, then the new file is verified', async () => {
  const t = tmpHome();
  try {
    const acl = fakeAcl();
    const logs: string[] = [];
    const r = await loadOrCreateAuthSecret(t.home, { platform: 'win32', winAcl: acl, log: (l, m) => logs.push(`${l}:${m}`) });
    assert.equal(r.created, true);
    assert.deepEqual(acl.calls, ['inspect 1', `tighten dir ${USER} []`, 'inspect 1', 'inspect 1']);
    assert.deepEqual(acl.secretExistedAtTighten, [false], 'the secret never exists under the broad ACL');
    assert.deepEqual(readFileSync(authSecretPath(t.home)), r.secret);
    assert.ok(logs.some((l) => l.includes('owner-only home folder')));
    // 두 번째 시작: 이미 본인 전용 — 조이지 않고 같은 비밀
    acl.calls.length = 0;
    const again = await loadOrCreateAuthSecret(t.home, { platform: 'win32', winAcl: acl });
    assert.equal(again.created, false);
    assert.deepEqual(again.secret, r.secret);
    assert.deepEqual(acl.calls, ['inspect 1', 'inspect 1']);
  } finally {
    t.cleanup();
  }
});

test('win32: ACL tightening failure is fatal and leaves no secret behind', async () => {
  for (const mode of ['failTighten', 'tightenNoEffect', 'failInspect'] as const) {
    const t = tmpHome();
    try {
      const acl = fakeAcl();
      acl[mode] = true;
      await assert.rejects(
        loadOrCreateAuthSecret(t.home, { platform: 'win32', winAcl: acl }),
        (e: AuthSecretError) => (mode === 'failInspect' ? e.code === 'EACLCHECK' : e.code === 'EACL'),
        mode,
      );
      assert.equal(existsSync(authSecretPath(t.home)), false, `${mode}: no secret written`);
    } finally {
      t.cleanup();
    }
  }
});

test('win32: a home owned by another user is refused, never tightened or written to', async () => {
  const t = tmpHome();
  try {
    const acl = fakeAcl({ fixed: { [t.home]: `O:${OTHER}G:${OTHER}D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;${OTHER})` } });
    await assert.rejects(loadOrCreateAuthSecret(t.home, { platform: 'win32', winAcl: acl }), code('EOWNER'));
    assert.ok(!acl.calls.some((c) => c.startsWith('tighten')));
    assert.equal(existsSync(authSecretPath(t.home)), false);
  } finally {
    t.cleanup();
  }
});

test('win32: explicit grants to other principals are removed from the home', async () => {
  const t = tmpHome();
  try {
    const acl = fakeAcl({ fixed: { [t.home]: `O:${USER}D:PAI(A;OICI;FA;;;${USER})(A;OICI;0x1301ff;;;AU)(A;OICI;FR;;;${OTHER})` } });
    await loadOrCreateAuthSecret(t.home, { platform: 'win32', winAcl: acl });
    assert.ok(acl.calls.includes(`tighten dir ${USER} [S-1-5-11,${OTHER}]`), acl.calls.join(' | '));
  } finally {
    t.cleanup();
  }
});

test('win32: a secret that existed under a broad home ACL is rotated after tightening', async () => {
  const t = tmpHome();
  try {
    mkdirSync(t.home, { recursive: true });
    const old = randomBytes(32);
    writeFileSync(authSecretPath(t.home), old);
    await new Promise((r) => setTimeout(r, 20));
    const logs: string[] = [];
    const r = await loadOrCreateAuthSecret(t.home, { platform: 'win32', winAcl: fakeAcl(), log: (l, m) => logs.push(`${l}:${m}`) });
    assert.equal(r.created, true);
    assert.notDeepEqual(r.secret, old, 'possibly-leaked secret is not reused');
    assert.ok(logs.some((l) => l.startsWith('warn:') && l.includes('regenerating')));
  } finally {
    t.cleanup();
  }
});

test('win32: a secret file with a foreign owner or broad ACL in a private home is regenerated', async () => {
  for (const sddl of [`O:${OTHER}D:PAI(A;;FA;;;${USER})`, `O:${USER}D:PAI(A;;FA;;;${USER})(A;;FR;;;${SANDBOX})`]) {
    const t = tmpHome();
    try {
      mkdirSync(t.home, { recursive: true });
      const planted = randomBytes(32);
      writeFileSync(authSecretPath(t.home), planted);
      const acl = fakeAcl({ privateDirs: [t.home], fixed: { [authSecretPath(t.home)]: sddl } });
      // 새로 쓴 파일은 (가짜에서) 고정 SDDL이 그대로 남지 않게: 지워지면 상속 ACL로 보여요
      const origInspect = acl.inspect;
      acl.inspect = async (paths) => {
        if (!existsSync(authSecretPath(t.home)) || !readFileSync(authSecretPath(t.home)).equals(planted)) acl.fixed.delete(authSecretPath(t.home));
        return origInspect(paths);
      };
      const r = await loadOrCreateAuthSecret(t.home, { platform: 'win32', winAcl: acl });
      assert.equal(r.created, true);
      assert.notDeepEqual(r.secret, planted);
      assert.ok(!acl.calls.some((c) => c.startsWith('tighten')), 'home was already private');
    } finally {
      t.cleanup();
    }
  }
});

test('win32: a newly created secret that is not private is deleted and startup fails', async () => {
  const t = tmpHome();
  try {
    const acl = fakeAcl({ privateDirs: [] });
    acl.privateDirs.add(t.home);
    acl.fixed.set(authSecretPath(t.home), `O:${USER}D:AI(A;ID;FA;;;${USER})(A;ID;FR;;;WD)`);
    const origInspect = acl.inspect;
    let reads = 0;
    // 처음 읽을 때는 파일이 없으니 고정 SDDL은 새 파일에만 적용돼요
    acl.inspect = async (paths) => {
      reads++;
      return origInspect(paths);
    };
    await assert.rejects(loadOrCreateAuthSecret(t.home, { platform: 'win32', winAcl: acl }), code('EACL'));
    assert.equal(existsSync(authSecretPath(t.home)), false);
    assert.ok(reads >= 2);
  } finally {
    t.cleanup();
  }
});

// ───────── 창(클라이언트): Windows ACL ─────────

test('win32 client: checks owner and DACL of both home and auth.secret on every read', async () => {
  const t = tmpHome();
  try {
    mkdirSync(t.home, { recursive: true });
    const secret = randomBytes(32);
    writeFileSync(authSecretPath(t.home), secret);
    const file = authSecretPath(t.home);

    const ok = fakeAcl({ privateDirs: [t.home] });
    assert.deepEqual(await readAuthSecret(t.home, { platform: 'win32', winAcl: ok }), secret);
    assert.deepEqual(await readAuthSecret(t.home, { platform: 'win32', winAcl: ok }), secret);
    assert.deepEqual(ok.calls, ['inspect 2', 'inspect 2'], 'home + file, each read (no cache for injected checkers)');

    // home이 넓으면(다른 사용자가 바꿔치기·쓰기 가능) 거부
    await assert.rejects(readAuthSecret(t.home, { platform: 'win32', winAcl: fakeAcl() }), (e: AuthSecretError) => e.code === 'EACL' && /home folder/.test(e.message));
    // 다른 사용자가 만든 home
    await assert.rejects(
      readAuthSecret(t.home, { platform: 'win32', winAcl: fakeAcl({ fixed: { [t.home]: `O:${OTHER}D:PAI(A;OICI;FA;;;${USER})` } }) }),
      code('EOWNER'),
    );
    // 다른 사용자가 심어 둔 비밀(DACL은 본인 전용처럼 보여도)
    await assert.rejects(
      readAuthSecret(t.home, { platform: 'win32', winAcl: fakeAcl({ privateDirs: [t.home], fixed: { [file]: `O:${OTHER}D:PAI(A;;FA;;;${USER})` } }) }),
      (e: AuthSecretError) => e.code === 'EOWNER' && /auth secret/.test(e.message),
    );
    // 샌드박스 사용자가 읽을 수 있는 비밀
    await assert.rejects(
      readAuthSecret(t.home, { platform: 'win32', winAcl: fakeAcl({ privateDirs: [t.home], fixed: { [file]: BROAD } }) }),
      code('EACL'),
    );
    // 검사를 못 하면 거부(fail closed)
    const broken = fakeAcl({ privateDirs: [t.home] });
    broken.failInspect = true;
    await assert.rejects(readAuthSecret(t.home, { platform: 'win32', winAcl: broken }), code('EACLCHECK'));
    // 클라이언트는 절대 조이지 않아요
    assert.ok(!ok.calls.some((c) => c.startsWith('tighten')));
  } finally {
    t.cleanup();
  }
});

test('ensurePrivateDir is a no-op off Windows', async () => {
  const t = tmpHome();
  try {
    const r = await ensurePrivateDir(t.home, { platform: 'linux', winAcl: trustingAcl });
    assert.equal(r.tightened, false);
    assert.ok(existsSync(t.home));
  } finally {
    t.cleanup();
  }
});

// ───────── 진짜 Windows (PowerShell + icacls) ─────────

if (process.platform === 'win32') {
  const icacls = (...args: string[]) => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), args, { windowsHide: true });

  test('real Windows: home tightened, secret private, client accepts; broad grants are detected and removed', { timeout: 120_000 }, async () => {
    const t = tmpHome();
    try {
      const r = await loadOrCreateAuthSecret(t.home);
      assert.equal(r.created, true);
      const snap = await windowsAcl.inspect([t.home, authSecretPath(t.home)]);
      assert.equal(checkPrivateAcl(snap.sddl[0]!, snap.userSid).ok, true, snap.sddl[0]);
      assert.equal(checkPrivateAcl(snap.sddl[1]!, snap.userSid).ok, true, snap.sddl[1]);
      assert.match(snap.sddl[0]!, /D:P/, 'inheritance removed from the home');
      assert.deepEqual(await readAuthSecret(t.home), r.secret);

      // 누가 비밀 파일에 Authenticated Users 읽기를 붙이면: 창은 거부, 데몬은 새로 만들어요
      icacls(authSecretPath(t.home), '/grant', '*S-1-5-11:R');
      await assert.rejects(readAuthSecret(t.home), code('EACL'));
      const r2 = await loadOrCreateAuthSecret(t.home);
      assert.equal(r2.created, true);
      assert.notDeepEqual(r2.secret, r.secret);
      assert.deepEqual(await readAuthSecret(t.home), r2.secret);

      // home에 명시적 허용 ACE를 붙이면: 창은 거부, 데몬은 지우고 비밀을 바꿔요
      icacls(t.home, '/grant', '*S-1-5-11:(OI)(CI)R');
      await assert.rejects(readAuthSecret(t.home), (e: AuthSecretError) => e.code === 'EACL' && /home folder/.test(e.message));
      const r3 = await loadOrCreateAuthSecret(t.home);
      assert.equal(r3.created, true);
      assert.notDeepEqual(r3.secret, r2.secret);
      const snap3 = await windowsAcl.inspect([t.home]);
      assert.equal(checkPrivateAcl(snap3.sddl[0]!, snap3.userSid).ok, true, snap3.sddl[0]);
      assert.deepEqual(await readAuthSecret(t.home), r3.secret);
    } finally {
      t.cleanup();
    }
  });
}
