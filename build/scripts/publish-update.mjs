// Mk42 업데이트 게시 (2026-11-05) — 설치 마법사 exe를 업데이트 채널(mk42.estre.so)에 올려요.
//
//   node build/scripts/publish-update.mjs [--exe <Mk42-Setup-*.exe>] [--channel internal|stable] [--notes-ko <글>] [--notes-en <글>]
//                                         [--app-version <태그-커밋>] [--ssh <호스트 별칭>] [--key <서명 개인 키>] [--dry-run] [--allow-stable]
//
// 1) exe의 크기·sha256 → latest.json(계약: 문서 repo .agent/_contracts, mk42.estre.so README)
// 2) Ed25519 서명(개인 키는 빌드 PC ~/.secrets/mk42-update-signing.key) → latest.json.sig(base64). repo의 공개 키로 다시 확인해요 —
//    다른 키로 서명하면 설치본이 전부 거절하니까 올리기 전에 막아요.
// 3) `ssh mk42-publish put <채널> <이름>`(표준 입력) 세 번 → `commit <채널>`. 서버의 강제 명령이 크기·sha256·서명을 다시 확인하고,
//    설치 파일 → .sig → latest.json 순서로 바꿔 끼운 뒤 옛 설치 파일을 지워요(채널마다 최신 하나만). 지난 판은 여기 dist에만 남아요.
// 개인 키·내부 채널 비밀번호는 읽기만 하고 출력하지 않아요.
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream, existsSync, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoot } from './paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const distDir = join(buildRoot(), 'dist');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(name);
const fail = (msg) => {
  console.error(`publish-update: ${msg}`);
  process.exit(1);
};

const channel = arg('--channel') ?? 'internal';
if (!['internal', 'stable'].includes(channel)) fail(`unknown channel ${channel}`);
if (channel === 'stable' && !flag('--allow-stable')) fail('stable is the public channel — pass --allow-stable once publishing is decided (public release gate)');
const sshHost = arg('--ssh') ?? 'mk42-publish';
const keyPath = arg('--key') ?? join(homedir(), '.secrets', 'mk42-update-signing.key');
const dryRun = flag('--dry-run');

const FILE_RE = /^Mk42-Setup-(\d+(?:\.\d+)*)\.exe$/;
const versionKey = (v) => v.split('.').map(Number);
const cmpVersion = (a, b) => {
  const pa = versionKey(a), pb = versionKey(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

async function newestExe() {
  const names = (await fsp.readdir(distDir)).filter((n) => FILE_RE.test(n));
  if (!names.length) fail(`no Mk42-Setup-*.exe in ${distDir}`);
  names.sort((a, b) => cmpVersion(FILE_RE.exec(a)[1], FILE_RE.exec(b)[1]));
  return join(distDir, names.at(-1));
}

const exe = resolve(arg('--exe') ?? (await newestExe()));
const file = basename(exe);
const m = FILE_RE.exec(file);
if (!m) fail(`installer name must be Mk42-Setup-<version>.exe: ${file}`);
const version = m[1];

// 같은 dist의 패키지 폴더 manifest가 있어야 해요 — 그 설치 파일이 어느 채널용으로 만들어졌는지(update.json·update.secret)를 봐요.
// 내부판(비밀번호가 든 판)을 공개 채널에 올리거나, 다른 채널 판을 올려 설치본의 채널·비밀번호가 바뀌는 사고를 막아요(검토 2026-11-05).
let appVersion = arg('--app-version');
const pkgManifest = join(dirname(exe), `Mk42-${version}`, 'manifest.json');
if (!existsSync(pkgManifest)) fail(`package manifest not found: ${pkgManifest} — publish only installers built here with package.mjs --exe --update-channel ${channel}`);
const man = JSON.parse(await fsp.readFile(pkgManifest, 'utf8'));
const builtFor = man.update?.channel;
if (builtFor !== channel) fail(`${file} was built for channel ${builtFor ?? '(none)'}, not ${channel} — rebuild with package.mjs --update-channel ${channel}`);
if (channel === 'stable' && man.update?.secret) fail(`${file} carries an internal credential (update.secret) — never publish it to the public channel`);
appVersion ??= man.components?.find((c) => c.name === 'app')?.version;
if (!appVersion) fail(`app version unknown — pass --app-version (no ${pkgManifest})`);

async function sha256Of(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}
const size = (await fsp.stat(exe)).size;
const sha256 = await sha256Of(exe);

const notes = {
  ko: arg('--notes-ko') ?? `Mk42 ${version}`,
  en: arg('--notes-en') ?? `Mk42 ${version}`,
};
const manifest = {
  schema: 1,
  product: 'mk42',
  channel,
  version,
  appVersion,
  publishedAt: new Date().toISOString(),
  file,
  size,
  sha256,
  notes,
};
const body = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

if (!existsSync(keyPath)) fail(`signing key not found: ${keyPath}`);
const privateKey = createPrivateKey(await fsp.readFile(keyPath));
const signature = sign(null, body, privateKey);
const publicPem = await fsp.readFile(join(repo, 'build', 'update-signing.pub.pem'), 'utf8');
if (!verify(null, body, createPublicKey(publicPem), signature)) fail('signing key does not match build/update-signing.pub.pem — installs would reject this update');
const sig = Buffer.from(signature.toString('base64') + '\n', 'utf8');

console.log(`channel ${channel}: ${file} (${(size / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…), app ${appVersion}`);
if (dryRun) {
  console.log(body.toString('utf8'));
  console.log('dry run — nothing uploaded');
  process.exit(0);
}

/** ssh 강제 명령 한 번 — 표준 입력으로 파일(또는 버퍼)을 넘겨요 */
function remote(args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', sshHost, ...args], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolvePromise(out.trim()) : reject(new Error(`ssh ${args.join(' ')} exited ${code}`))));
    if (typeof input === 'string') {
      const rs = createReadStream(input);
      rs.once('error', reject);
      rs.pipe(child.stdin);
    } else child.stdin.end(input ?? Buffer.alloc(0));
  });
}

try {
  console.log(await remote(['put', channel, file], exe));
  console.log(await remote(['put', channel, 'latest.json'], body));
  console.log(await remote(['put', channel, 'latest.json.sig'], sig));
  console.log(await remote(['commit', channel]));
} catch (e) {
  fail(`${e instanceof Error ? e.message : e} — the server keeps the previous release until commit succeeds`);
}
console.log(`published ${version} to ${channel}. Older installers stay only in ${distDir}.`);
