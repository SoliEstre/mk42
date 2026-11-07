// Mk42 설치 패키지 만들기 — 다른 PC(또는 이 PC)에 Setup.cmd 한 번으로 설치하는 폴더(+ 원하면 zip).
//   node build/scripts/package.mjs [--app <Mk42 앱 폴더>] [--app-version <태그-커밋>] [--out <폴더>] [--exe] [--zip] [--skip-build]
//   --exe: 설치 마법사 Mk42-Setup-<버전>.exe도 만들어요(Inno Setup 6 필요, build/installer/mk42.iss)
//   --update-channel internal|stable [--update-url <주소>] [--update-auth-file <파일>]: 자체 업데이트 채널을 담아요(update-channel.mjs, 계약 C4)
// 기본 앱 폴더: 이 PC 데몬 설정(registry.json)의 Mark42 앱(지금 쓰는 검증된 빌드). 새 빌드를 넣으려면 build.ps1 → install.ps1 뒤 그 폴더를 --app으로.
// 구성 요소(manifest.json): runtime(node.exe — 이 스크립트를 돌리는 Node) · daemon(mk42d + 통합 창 UI) · app · hub(mk42-hub.exe) · extension(.vsix)
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAppRuntimeArtifact, listFiles, MANIFEST_FILE, PACKAGE_SCHEMA, packageVersionAt, treeHash, compareVersions } from '../../daemon/src/setup/manifest.ts';
import { resolveUpdateChannel, writePackageUpdate } from './update-channel.mjs';
import { buildRoot, readUpstream } from './paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const upstream = readUpstream();

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(name);
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, stdio: 'inherit' });
// npm은 Windows에서 npm.cmd라 셸로만 띄울 수 있어요 — 인자는 고정 문자열이라 한 줄 명령으로 넘겨요
const npm = (line) => execFileSync(`npm ${line}`, { cwd: repo, stdio: 'inherit', shell: true });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' }).trim();

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) throw new Error(`Node 24+ needed (this is ${process.version}) — the bundled runtime is the Node running this script`);

// 업데이트 채널(계약 C4): --update-channel internal|stable [--update-url <바탕 주소>] [--update-auth-file <user:password 파일, internal만>]
// 빌드 전에 확인해요(잘못된 조합으로 몇 분 빌드하지 않게). 자격 증명 내용은 출력하지 않아요
const updateChannel = await resolveUpdateChannel(
  { channel: arg('--update-channel'), url: arg('--update-url'), authFile: arg('--update-auth-file') },
  { publicKeyFile: join(repo, 'build', 'update-signing.pub.pem') },
);

// ---- 입력 ----
const commit = out('git', ['rev-parse', '--short=7', 'HEAD']);
const dirty = out('git', ['status', '--porcelain']) !== '';
const created = new Date();
const version = packageVersionAt(created);

if (!flag('--skip-build')) {
  console.log('build: daemon + extension, extension vsix, hub exe');
  npm('run build');
  npm('run package -w extension');
}
// 통합 창 exe는 늘 새로 게시해요(임시 폴더, 끝나면 지움) — 설치된 %LOCALAPPDATA%\Mark42\hub를 건드리지 않게
const hubPublish = join(tmpdir(), `mk42-hub-publish-${process.pid}`);
sh('dotnet', ['publish', join('hub-host', 'src', 'Mark42.Hub'), '-p:PublishProfile=win-x64', '-o', hubPublish]);

async function defaultAppDir() {
  const home = process.env.MARK42_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Mark42');
  const reg = JSON.parse(await fsp.readFile(join(home, 'registry.json'), 'utf8'));
  const app = (reg.settings?.apps ?? []).find((a) => a.product === 'mark42' && existsSync(a.exe));
  if (!app) throw new Error("no Mark42 app in this PC's registry.json — pass --app <folder>");
  return dirname(app.exe);
}
const appDir = resolve(arg('--app') ?? (await defaultAppDir()));
if (!existsSync(join(appDir, 'Mk42.exe'))) throw new Error(`no Mk42.exe in ${appDir}`);
const appVersion = arg('--app-version') ?? /^Mk42-(.+)$/.exec(basename(appDir))?.[1];
if (!appVersion) throw new Error('cannot tell the app version from the folder name — pass --app-version <tag>-<commit>');

const vsixDir = join(repo, 'extension', 'out');
const vsix = (await fsp.readdir(vsixDir))
  .map((n) => /^mark42-(\d+\.\d+\.\d+)\.vsix$/.exec(n))
  .filter(Boolean)
  .sort((a, b) => compareVersions(b[1], a[1]))[0];
if (!vsix) throw new Error(`no mark42-<version>.vsix in ${vsixDir}`);

// ---- 조립 ----
const outRoot = resolve(arg('--out') ?? join(buildRoot(), 'dist'));
const name = `Mk42-${version}`;
const final = join(outRoot, name);
const partial = `${final}.partial`;
await fsp.rm(partial, { recursive: true, force: true });
await fsp.mkdir(partial, { recursive: true });
const put = async (from, to) => {
  await fsp.mkdir(dirname(join(partial, to)), { recursive: true });
  await fsp.copyFile(from, join(partial, to));
};

console.log(`assemble ${name}: app ${appVersion} from ${appDir}`);
await put(process.execPath, 'runtime/node.exe');
await put(join(repo, 'daemon', 'dist', 'mk42d.mjs'), 'daemon/daemon/dist/mk42d.mjs');
await put(join(repo, 'extension', 'hub-ui', 'index.html'), 'daemon/extension/hub-ui/index.html');
await put(join(repo, 'extension', 'dist', 'hub-ui.js'), 'daemon/extension/dist/hub-ui.js');
await put(join(repo, 'extension', 'dist', 'hub-ui.css'), 'daemon/extension/dist/hub-ui.css');
await put(join(hubPublish, 'mk42-hub.exe'), 'hub/mk42-hub.exe');
await put(join(vsixDir, vsix[0]), `extension/${vsix[0]}`);
// 앱이 실행 중에 자기 폴더에 쓰는 것(debug.log, Node 컴파일 캐시)은 빼요 — 설치본과 비교할 때 판이 다르게 보이지 않게
await fsp.cp(appDir, join(partial, 'app'), {
  recursive: true,
  filter: (src) => src === appDir || !isAppRuntimeArtifact(relative(appDir, src)),
});
await put(join(repo, 'daemon', 'dist', 'mk42-setup.mjs'), 'setup/mk42-setup.mjs');

const componentDefs = [
  { name: 'runtime', version: process.versions.node, dir: 'runtime' },
  { name: 'daemon', version, dir: 'daemon' },
  { name: 'app', version: appVersion, dir: 'app' },
  { name: 'hub', version, dir: 'hub' },
  { name: 'extension', version: vsix[1], dir: 'extension' },
];
const components = [];
await fsp.mkdir(join(partial, 'files'), { recursive: true });
for (const c of componentDefs) {
  const files = await listFiles(join(partial, c.dir));
  await fsp.writeFile(join(partial, 'files', `${c.name}.json`), `${JSON.stringify(files)}\n`);
  components.push({ ...c, treeHash: treeHash(files), fileCount: files.length, size: files.reduce((n, f) => n + f.size, 0) });
  console.log(`  ${c.name} ${c.version}: ${files.length} files, ${(components.at(-1).size / 1048576).toFixed(1)} MB`);
}
const manifest = {
  schema: PACKAGE_SCHEMA,
  product: 'mark42',
  version,
  createdAt: created.toISOString(),
  source: { mark42Commit: commit, dirty, upstreamTag: upstream.tag, upstreamCommit: upstream.commit },
  appExe: 'Mk42.exe',
  components,
  // update.json(·update.secret)은 패키지 루트에 — 크기·sha256을 여기 담아 엔진이 맞춰 봐요
  ...(updateChannel ? { update: await writePackageUpdate(partial, updateChannel) } : {}),
};
if (updateChannel) {
  console.log(`  update: channel ${updateChannel.config.channel} ${updateChannel.config.url}${updateChannel.secret !== undefined ? ' + channel credential (update.secret — internal build, do not share this package)' : ''}`);
}
await fsp.writeFile(join(partial, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

await fsp.writeFile(
  join(partial, 'Setup.cmd'),
  [
    '@echo off',
    'chcp 65001 >nul',
    'rem Mk42 설치·갱신 — 동봉한 node.exe로 setup\\mk42-setup.mjs를 실행해요. 인자는 그대로 넘겨요(예: --dry-run, --no-autostart).',
    '"%~dp0runtime\\node.exe" "%~dp0setup\\mk42-setup.mjs" install --package "%~dp0." %*',
    'set MK42_SETUP_EXIT=%ERRORLEVEL%',
    'if "%MK42_SETUP_NOPAUSE%"=="" pause',
    'exit /b %MK42_SETUP_EXIT%',
    '',
  ].join('\r\n'),
);
await fsp.writeFile(
  join(partial, 'README.txt'),
  [
    `Mk42 ${version} (mark42 ${commit}${dirty ? ' dirty' : ''}, Code - OSS ${upstream.tag}, app ${appVersion})`,
    '',
    '설치: Setup.cmd를 실행해요(관리자 권한 필요 없음). 이미 설치돼 있으면 새 버전으로 바꿔요.',
    '  - 설치 위치: %LOCALAPPDATA%\\Mark42 (app\\Mk42-<버전>, daemon\\<버전>, runtime\\node-<버전>, hub\\mk42-hub.exe, extension\\)',
    '  - 로그온 때 데몬 자동 실행(작업 스케줄러 Mark42\\mk42d), 시작 메뉴 «Mk42»(통합 창)',
    '  - 이미 떠 있는 데몬은 껐다 다시 띄워요. Mk42 창은 닫히지 않고 새 데몬에 다시 붙어요.',
    '  - 미리 보기: Setup.cmd --dry-run    로그: %LOCALAPPDATA%\\Mark42\\logs\\mk42-setup.log',
    '',
    '처음 설치한 PC에서는 Mk42 창을 처음 띄울 때 한국어 언어팩·Codex·Claude Code 확장을 받아요(인터넷 필요).',
    'Claude Code·Codex는 깔기 전에 공식 판의 기준 해시와 대조하고, 기준이 없으면 설치 전에 확인을 물어요.',
    '',
  ].join('\r\n'),
);

await fsp.rm(final, { recursive: true, force: true });
await fsp.rename(partial, final);
await fsp.rm(hubPublish, { recursive: true, force: true });
console.log(`package: ${final}`);

// 설치 마법사 exe(Inno Setup 6) — 패키지 폴더를 통째로 담고, 실행하면 임시 폴더에 풀어 같은 엔진을 돌려요(build/installer/mk42.iss)
function findIscc() {
  const candidates = [
    process.env.ISCC,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Inno Setup 6 (ISCC.exe) not found — winget install JRSoftware.InnoSetup --scope user, or set ISCC');
  return found;
}
/** Windows 파일 버전은 칸마다 65535까지라 `YYYY.MMDD.HHmmss`의 시각 칸을 «하루 중 초 ÷ 2»로 바꿔요 */
function fileVersionOf(v) {
  const [y, md, hms] = v.split('.');
  const t = hms.padStart(6, '0');
  const sec = Number(t.slice(0, 2)) * 3600 + Number(t.slice(2, 4)) * 60 + Number(t.slice(4, 6));
  return `${Number(y)}.${Number(md)}.${Math.floor(sec / 2)}.0`;
}
if (flag('--exe')) {
  const iscc = findIscc();
  // ISCC는 BOM 없는 UTF-8을 ANSI로 읽을 수 있어서, BOM을 붙인 사본으로 컴파일해요(한국어 문구)
  const issText = await fsp.readFile(join(repo, 'build', 'installer', 'mk42.iss'), 'utf8');
  const iss = join(tmpdir(), `mk42-setup-${process.pid}.iss`);
  await fsp.writeFile(iss, `\uFEFF${issText.replace(/^\uFEFF/, '')}`);
  const exeBase = `Mk42-Setup-${version}`;
  console.log(`setup exe: compiling with ${iscc} (lzma2, a few minutes)`);
  try {
    execFileSync(
      iscc,
      [
        '/Q',
        `/DPkgDir=${final}`,
        `/DAppVersion=${version}`,
        `/DVersionInfo=${fileVersionOf(version)}`,
        `/DOutputDir=${outRoot}`,
        `/DOutputBase=${exeBase}`,
        `/DIconFile=${join(repo, 'build', 'assets', 'mk42.ico')}`,
        `/DSourceInfo=mark42 ${commit}${dirty ? ' dirty' : ''}, Code - OSS ${upstream.tag}, app ${appVersion}`,
        iss,
      ],
      { stdio: 'inherit' },
    );
  } finally {
    await fsp.rm(iss, { force: true });
  }
  const exe = join(outRoot, `${exeBase}.exe`);
  console.log(`setup exe: ${exe} (${((await fsp.stat(exe)).size / 1048576).toFixed(0)} MB)`);
}

if (flag('--zip')) {
  const zip = `${final}.zip`;
  await fsp.rm(zip, { force: true });
  // Windows 기본 bsdtar로 zip — 받는 쪽은 탐색기 «압축 풀기»로 풀어요. PATH의 tar는 Git Bash의 GNU tar(zip 못 만듦)일 수 있어서 경로를 박아요
  const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(bsdtar, ['-a', '-c', '-f', zip, '-C', outRoot, name], { stdio: 'inherit' });
  console.log(`zip: ${zip} (${((await fsp.stat(zip)).size / 1048576).toFixed(0)} MB)`);
}
