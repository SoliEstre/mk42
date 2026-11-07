// mk42-setup — Mk42 설치 패키지를 이 PC에 설치·갱신해요. 패키지의 Setup.cmd가 동봉한 node.exe로 이 번들(setup\mk42-setup.mjs)을 실행해요.
//   install [--package <dir>] [--home <dir>] [--pipe <name>] [--mk42-data <dir>] [--no-autostart] [--no-start] [--no-shortcut] [--dry-run]
//   status  [--home <dir>]
//   stop    [--home <dir>] [--pipe <name>]
// 나중에 업데이트 서버가 생기면 데몬이 같은 패키지를 받아 해시를 맞춘 뒤 이 엔진을 그대로 돌려요(install.json이 지금 설치 상태).
import { spawn } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateAuthSecret } from '@mark42/protocol/auth';
import { defaultMark42Home, defaultPipeName, samePath } from '@mark42/protocol/paths';
import { Autostart, type TaskAction } from '../autostart.ts';
import { autostartEntryArgs } from '../config.ts';
import { atomicWriteFile, errCode, renameWithRetry, timestampForFile } from '../fsutil.ts';
import { createFileLogger, errMsg, type Logger } from '../log.ts';
import { REGISTRY_FILE, Registry } from '../registry.ts';
import { askRunningDaemon, verifyRunningDaemon } from '../secondInstance.ts';
import type { UiLanguage } from '../i18n.ts';
import { busyMessage, setupLanguage, setupText, SetupUserError } from './messages.ts';
import {
  isAppRuntimeArtifact,
  MANIFEST_FILE,
  sha256File,
  summarizeTree,
  treeHash,
  UPDATE_CONFIG_FILE,
  UPDATE_SECRET_FILE,
  validateManifest,
  type ComponentManifest,
  type FileEntry,
  type PackageManifest,
} from './manifest.ts';
import {
  applyInstallToSettings,
  decideTask,
  DAEMON_ENTRY,
  HUB_EXE,
  installPaths,
  NODE_EXE,
  isDaemonCommandLine,
  isInside,
  planUpdateRecord,
  removeInstallFromSettings,
  targetFor,
  upstreamVersionOf,
  type UpdateRecord,
} from './plan.ts';
import { parseUpdateConfig, UPDATES_DIR, type UpdateConfig } from '../updater.ts';

export const INSTALL_RECORD = 'install.json';
/** 설치가 데몬을 끈 뒤 끝날 때까지 있는 표시 — 끊긴 처음 설치를 다시 돌릴 때 «처음 설치»를 기억해요 */
export const PENDING_FILE = 'install.pending';

const USAGE = `mk42-setup — Mk42 설치·갱신
  install   패키지를 설치해요(이미 있는 버전 폴더는 건너뛰어요)
    --package <dir>     패키지 폴더(기본: 이 스크립트의 위 폴더)
    --home <dir>        Mark42 home(기본 %LOCALAPPDATA%\\Mark42 또는 MARK42_HOME)
    --pipe <name>       데몬 파이프(기본: 사용자·home에서)
    --mk42-data <dir>   Mk42 앱 user-data·확장 폴더 자리(기본 %USERPROFILE%\\.mk42, 기존 설정이 있으면 그것)
    --no-autostart      로그온 작업을 새로 만들지 않아요(이 home의 작업이 이미 있으면 새 경로로 바꿔요)
                        처음 설치여도 작업은 기본 home일 때만 만들어요(시험·두 번째 home이 사용자 작업을 빼앗지 않게)
    --no-start          꺼져 있던 데몬을 설치 뒤에 띄우지 않아요(떠 있던 데몬은 새 판으로 다시 띄워요)
    --no-shortcut       시작 메뉴 «Mk42» 바로 가기를 만들지 않아요
    --dry-run           검사와 계획만
  status    설치 기록(install.json)과 데몬 상태
  stop      이 home의 데몬을 꺼요(Mk42 창은 그대로)
  uninstall 프로그램(runtime·daemon·app·hub·extension·setup 폴더)·로그온 작업·시작 메뉴를 지워요. 설정·기록은 남겨요
    --check             지울 수 있는지만(Mk42 창·통합 창이 떠 있으면 종료 코드 3 — 창은 닫지 않아요)
    --purge             home 폴더 전체(설정·기록 포함)도 지워요. Mk42 앱 데이터(%USERPROFILE%\\.mk42)는 그대로
    이 home의 runtime으로 돌리면 자기 자신을 못 지워서 거절해요 — 다른 곳에 복사한 node·엔진으로 돌려요(설치 마법사 제거가 그렇게 해요)
  공통
    --lang <ko|en>      MK42-ERROR(오류 상자) 문구 언어(기본: Windows 표시 언어 — 설치 마법사는 자기 언어를 넘겨요). 로그는 영어`;

/** 사용자 문구 언어 — main()이 --lang·Windows 표시 언어로 정해요 */
let uiLang: UiLanguage = 'en';

/** 제거할 프로그램 폴더(home 아래) — 설정·기록(registry.json, logs, roles 등)은 이 밖이에요 */
export const PROGRAM_DIRS = ['runtime', 'daemon', 'app', 'hub', 'extension', 'setup'] as const;
/** 설치 마법사(Inno Setup)의 제거 프로그램 폴더 — 마법사가 스스로 지워서 --purge도 건드리지 않아요 */
export const WIZARD_UNINSTALL_DIR = 'uninstall';
const SETUP_SCRIPT = 'mk42-setup.mjs';
const EXIT_BUSY = 3;

interface SetupArgs {
  command: 'install' | 'status' | 'stop' | 'uninstall' | 'help';
  packageDir: string;
  home: string;
  pipe: string;
  mk42Data?: string;
  autostart: boolean;
  start: boolean;
  shortcut: boolean;
  dryRun: boolean;
  purge: boolean;
  check: boolean;
  /** --pipe를 줬는지 — 안 줬으면 제거는 설치 기록의 파이프를 써요(설치 때 다른 파이프를 줬을 수 있어서) */
  pipeGiven: boolean;
  /** --lang 값(없으면 Windows 표시 언어) */
  lang?: string;
}

function parseSetupArgs(argv: string[], env: NodeJS.ProcessEnv): SetupArgs {
  const [command = 'help', ...rest] = argv;
  let packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let home: string | undefined;
  let pipe: string | undefined;
  let mk42Data: string | undefined;
  let autostart = true;
  let start = true;
  let shortcut = true;
  let dryRun = false;
  let purge = false;
  let check = false;
  let lang: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--package') packageDir = resolve(value());
    else if (a === '--home') home = resolve(value());
    else if (a === '--pipe') pipe = value();
    else if (a === '--mk42-data') mk42Data = resolve(value());
    else if (a === '--no-autostart') autostart = false;
    else if (a === '--no-start') start = false;
    else if (a === '--no-shortcut') shortcut = false;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--purge') purge = true;
    else if (a === '--check') check = true;
    else if (a === '--lang') lang = value();
    else throw new Error(`unknown argument ${a}`);
  }
  // 기본 home을 다른 대소문자·끝 구분자로 줘도 같은 글자로 — 파이프 이름은 home 글자에서 만들어서 다르면 데몬이 둘 떠요
  const plainDefault = defaultMark42Home({ ...env, MARK42_HOME: undefined });
  const resolvedHome = home === undefined ? defaultMark42Home(env) : samePath(home, plainDefault) ? plainDefault : home;
  return {
    command: command === 'install' || command === 'status' || command === 'stop' || command === 'uninstall' ? command : 'help',
    packageDir,
    home: resolvedHome,
    pipe: pipe ?? defaultPipeName({ ...env, MARK42_HOME: resolvedHome }),
    ...(mk42Data ? { mk42Data } : {}),
    autostart,
    start,
    shortcut,
    dryRun,
    purge,
    check,
    pipeGiven: pipe !== undefined,
    ...(lang ? { lang } : {}),
  };
}

// ---- 구성 요소 복사 ----

type InstallOutcome = 'installed' | 'kept' | 'replaced';

async function verifyPackage(pkg: string, m: PackageManifest, log: Logger): Promise<void> {
  for (const c of m.components) {
    const t = Date.now();
    const s = await summarizeTree(join(pkg, c.dir));
    if (s.treeHash !== c.treeHash) throw new Error(`package component ${c.name} does not match ${MANIFEST_FILE} (damaged or changed copy)`);
    log.info(`verified ${c.name} ${c.version}: ${s.fileCount} files, ${(s.size / 1048576).toFixed(1)} MB (${Date.now() - t} ms)`);
  }
}

/** 패키지의 files\<구성 요소>.json — manifest의 treeHash와 맞을 때만 믿어요 */
async function componentFiles(pkg: string, c: ComponentManifest): Promise<FileEntry[]> {
  const list = (await readJson<FileEntry[]>(join(pkg, 'files', `${c.name}.json`))) ?? [];
  if (!Array.isArray(list) || treeHash(list) !== c.treeHash) throw new Error(`files/${c.name}.json does not match ${MANIFEST_FILE}`);
  return list;
}

/**
 * 이미 있는 버전 폴더가 이 패키지 판인지: 목록의 파일이 모두 같은 내용으로 있으면 그래요. 목록에 없는 파일은 보지 않아요 —
 * 앱은 실행 중에 exe 옆에 debug.log 같은 걸 써요(2026-11-03 실측). 다른 내용의 파일이 있으면 그 폴더는 다른 판이에요.
 */
async function sameVersionFolder(dest: string, files: readonly FileEntry[]): Promise<{ same: boolean; first?: string }> {
  for (const f of files) {
    if (isAppRuntimeArtifact(f.path)) continue; // 옛 패키지는 이것도 담았어요 — 실행하면 바뀌어요
    const p = join(dest, ...f.path.split('/'));
    try {
      const st = await fsp.stat(p);
      if (st.size !== f.size || (await sha256File(p)) !== f.sha256) return { same: false, first: f.path };
    } catch {
      return { same: false, first: f.path };
    }
  }
  return { same: true };
}

async function installDir(src: string, dest: string, c: ComponentManifest, files: readonly FileEntry[], log: Logger): Promise<InstallOutcome> {
  if (existsSync(dest)) {
    const r = await sameVersionFolder(dest, files);
    if (r.same) return 'kept';
    throw new Error(`${dest} already exists with different content (${r.first}) — not overwriting a version folder (remove it or build a new version)`);
  }
  const partial = `${dest}.partial`;
  await fsp.rm(partial, { recursive: true, force: true });
  await fsp.mkdir(dirname(dest), { recursive: true });
  await fsp.cp(src, partial, { recursive: true, errorOnExist: true, force: false });
  const got = await summarizeTree(partial);
  if (got.treeHash !== c.treeHash) {
    await fsp.rm(partial, { recursive: true, force: true });
    throw new Error(`copy of ${c.name} does not match the package (disk full or changed during copy?)`);
  }
  await stripMarkOfTheWeb(partial);
  await renameWithRetry(partial, dest);
  log.info(`installed ${c.name} -> ${dest}`);
  return 'installed';
}

/** 한 자리 파일(통합 창 exe·확장 vsix): 같으면 그대로, 다르면 .new에 쓰고 바꿔 끼워요. 실행 중인 exe는 이름을 바꿔 비켜 놓아요. */
async function installFile(src: string, destDir: string, name: string, log: Logger): Promise<InstallOutcome> {
  const dest = join(destDir, name);
  await fsp.mkdir(destDir, { recursive: true });
  const want = await sha256File(src);
  if (existsSync(dest) && (await sha256File(dest)) === want) return 'kept';
  const next = `${dest}.new`;
  await fsp.copyFile(src, next);
  if ((await sha256File(next)) !== want) throw new Error(`copy of ${name} does not match the package`);
  await unlinkZoneIdentifier(next);
  const existed = existsSync(dest);
  try {
    await renameWithRetry(next, dest, { retries: 2 });
  } catch (e) {
    if (!existed) throw e;
    // 실행 중인 exe는 덮어쓸 수 없지만 이름은 바꿀 수 있어요 — 옛 파일을 비켜 놓고 새 파일을 그 자리에
    const aside = `${dest}.old-${timestampForFile()}`;
    await fsp.rename(dest, aside);
    await renameWithRetry(next, dest);
    log.info(`${name} was in use: moved it aside to ${basename(aside)} (removed on a later install)`);
  }
  log.info(`installed ${name} -> ${destDir}`);
  return existed ? 'replaced' : 'installed';
}

/**
 * 인터넷에서 받은 zip을 탐색기로 풀면 파일마다 «인터넷에서 받음» 표시(Zone.Identifier 대체 스트림)가 붙어요. 복사본에도 따라와서
 * 서명 없는 Mk42.exe·mk42-hub.exe를 띄울 때마다 SmartScreen이 막아요. 해시를 맞춘 설치본에서만 지워요(내용은 그대로).
 */
async function unlinkZoneIdentifier(file: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await fsp.unlink(`${file}:Zone.Identifier`).catch(() => undefined);
}

async function stripMarkOfTheWeb(dir: string): Promise<void> {
  if (process.platform !== 'win32') return;
  for (const e of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) await unlinkZoneIdentifier(join(e.parentPath, e.name));
  }
}

/** 확장 폴더에는 이 패키지의 vsix만 남겨요 — 데몬은 폴더에서 가장 높은 버전을 깔아서, 옛 높은 판이 남으면 되돌리기가 안 돼요 */
async function keepOnlyVsix(dir: string, name: string, log: Logger): Promise<void> {
  for (const e of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (e !== name && /^mark42-.+\.vsix$/i.test(e)) {
      await fsp.rm(join(dir, e), { force: true });
      log.info(`removed other extension package ${e}`);
    }
  }
}

async function removeAsideFiles(dir: string, name: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const e of entries) if (e.startsWith(`${name}.old-`)) await fsp.rm(join(dir, e), { force: true }).catch(() => undefined);
}

// ---- 데몬 끄기·띄우기 ----

async function pipeExists(pipe: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const s = connect(pipe);
    s.once('connect', () => {
      s.destroy();
      resolveP(true);
    });
    s.once('error', (e) => resolveP(errCode(e) !== 'ENOENT'));
  });
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

/** 이 파이프를 쥔 node 프로세스(옛 데몬 — `$/shutdown`이 없던 판)를 찾아 끝내요 */
async function killDaemonProcesses(pipe: string, log: Logger): Promise<number> {
  const ps = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
  ]);
  if (ps.code !== 0) throw new Error(`process list failed: ${ps.stderr.trim()}`);
  const raw = ps.stdout.trim();
  const list = (raw ? [JSON.parse(raw)].flat() : []) as { ProcessId: number; CommandLine: string | null }[];
  let n = 0;
  for (const p of list) {
    if (!p.CommandLine || p.ProcessId === process.pid || !isDaemonCommandLine(p.CommandLine, pipe)) continue;
    const r = await run('taskkill.exe', ['/PID', String(p.ProcessId), '/F']);
    if (r.code === 0) n++;
    log.info(`stopped old daemon process ${p.ProcessId} (${r.code === 0 ? 'ok' : r.stderr.trim()})`);
  }
  return n;
}

/** 'none' = 떠 있지 않음. 꺼도 Mk42 창은 그대로 돌고 새 데몬에 다시 붙어요. */
async function stopDaemon(home: string, pipe: string, log: Logger): Promise<'none' | 'shutdown' | 'killed'> {
  if (!(await pipeExists(pipe))) return 'none';
  try {
    await askRunningDaemon(pipe, home, '$/shutdown', {}, { timeoutMs: 5000 });
    if (await waitFor(async () => !(await pipeExists(pipe)), 10_000)) return 'shutdown';
    log.warn('daemon accepted shutdown but the pipe is still there — stopping the process');
  } catch (e) {
    log.info(`daemon did not take $/shutdown (${errMsg(e)}) — older daemon, stopping the process`);
  }
  const n = await killDaemonProcesses(pipe, log);
  if (!(await waitFor(async () => !(await pipeExists(pipe)), 10_000))) {
    throw new SetupUserError(`could not stop the daemon on ${pipe} (stopped ${n} process(es)) — close it and run setup again`, setupText(uiLang, 'daemonNotStopped'));
  }
  return 'killed';
}

function daemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MARK42_HOME;
  delete env.MARK42_PIPE;
  return env;
}

/** 새 데몬 번들이 이 node로 적어도 뜨는지(옛 데몬을 끄기 전에) — `--help`는 아무것도 열지 않고 끝나요 */
async function preflightDaemon(node: string, entry: string, home: string): Promise<void> {
  const r = await new Promise<{ code: number; out: string }>((resolveP, reject) => {
    const child = spawn(node, [entry, '--help'], { windowsHide: true, cwd: home, env: daemonEnv() });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? -1, out });
    });
  });
  if (r.code !== 0 || !r.out.includes('mk42d')) throw new Error(`new daemon does not start (${r.code}): ${r.out.trim().slice(0, 400)}`);
}

async function startDaemon(node: string, entry: string, home: string, pipe: string, log: Logger, extraArgs: string[] = []): Promise<void> {
  // 작업 폴더는 home — 패키지 폴더(USB·다운로드)를 데몬이 붙잡지 않게
  const child = spawn(node, [entry, ...extraArgs, '--home', home, '--pipe', pipe], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    cwd: home,
    env: daemonEnv(),
  });
  child.unref();
  const ok = await waitFor(async () => {
    try {
      await verifyRunningDaemon(pipe, home, { timeoutMs: 2000 });
      return true;
    } catch {
      return false;
    }
  }, 30_000, 500);
  if (!ok) {
    const daemonLog = join(home, 'logs', 'mk42d.log');
    throw new SetupUserError(`daemon did not come up on ${pipe} within 30 s — see ${daemonLog}`, setupText(uiLang, 'daemonNotStarted', daemonLog));
  }
  log.info(`daemon started (pid ${child.pid}) ${entry}`);
}

// ---- 바로 가기 ----

async function createStartMenuShortcut(hubExe: string, home: string, env: NodeJS.ProcessEnv, log: Logger): Promise<void> {
  const appData = env.APPDATA;
  if (!appData) return;
  const lnk = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Mk42.lnk');
  // 경로는 환경 변수로 넘겨요(명령줄 따옴표·주입 걱정 없게)
  const args = samePath(home, defaultMark42Home({ ...env, MARK42_HOME: undefined })) ? '' : `--home "${home}"`;
  const script =
    '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:MK42_LNK); $s.TargetPath=$env:MK42_TARGET; $s.Arguments=$env:MK42_ARGS; ' +
    "$s.WorkingDirectory=(Split-Path $env:MK42_TARGET); $s.IconLocation=$env:MK42_TARGET+',0'; $s.Description=$env:MK42_DESC; $s.Save()";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    ...process.env,
    MK42_DESC: setupText(uiLang, 'shortcutDescription'),
    MK42_LNK: lnk,
    MK42_TARGET: hubExe,
    MK42_ARGS: args,
  });
  if (r.code !== 0) log.warn(`start menu shortcut failed: ${r.stderr.trim()}`);
  else log.info(`start menu shortcut: ${lnk}`);
}

// ---- install ----

interface InstallRecord {
  schema: 1;
  product: 'mark42';
  package: { version: string; createdAt: string; source: PackageManifest['source'] };
  installedAt: string;
  home: string;
  pipe: string;
  components: Record<string, { version: string; path: string; treeHash: string }>;
  /** 업데이트 채널(계약 C4) — 패키지 update.json에서, 없으면 지난 설치 것. 데몬 updater.ts가 읽어요(공개 키 = 신뢰 기준) */
  update: UpdateRecord;
}

/**
 * 패키지의 update.json(+ update.secret)을 manifest의 크기·sha256과 맞추고 검사해요. 패키지에 채널이 없으면 undefined.
 * 자격 증명은 내용을 로그에 쓰지 않아요.
 */
async function readPackageUpdate(pkg: string, m: PackageManifest): Promise<{ config: UpdateConfig; secret?: string } | undefined> {
  if (!m.update) return undefined;
  const read = async (ref: { file: string; size: number; sha256: string }) => {
    const p = join(pkg, ref.file);
    const st = await fsp.stat(p);
    if (st.size !== ref.size || (await sha256File(p)) !== ref.sha256) throw new Error(`${ref.file} does not match ${MANIFEST_FILE}`);
    return fsp.readFile(p, 'utf8');
  };
  const parsed = parseUpdateConfig(JSON.parse(await read(m.update.config)));
  if ('error' in parsed) throw new Error(`${UPDATE_CONFIG_FILE}: ${parsed.error}`);
  if (parsed.channel !== m.update.channel) throw new Error(`${UPDATE_CONFIG_FILE} channel does not match ${MANIFEST_FILE}`);
  return { config: parsed, ...(m.update.secret ? { secret: await read(m.update.secret) } : {}) };
}

/** 설치 기록의 update 값을 정하고 `<home>\update.secret`을 쓰거나·두거나·지워요(planUpdateRecord). 자격 증명 실패는 설치를 멈추지 않아요 */
async function applyUpdateChannel(home: string, pkg: { config: UpdateConfig; secret?: string } | undefined, log: Logger): Promise<UpdateRecord> {
  const prev = (await readJson<InstallRecord>(join(home, INSTALL_RECORD)).catch(() => undefined))?.update;
  const plan = planUpdateRecord(prev, pkg?.config, pkg?.secret !== undefined);
  const secretFile = join(home, UPDATE_SECRET_FILE);
  try {
    if (plan.secret === 'write') {
      await atomicWriteFile(secretFile, pkg!.secret!);
      log.info(`${UPDATE_SECRET_FILE}: installed from the package`);
    } else if (plan.secret === 'remove' && existsSync(secretFile)) {
      await fsp.rm(secretFile, { force: true });
      log.info(`${UPDATE_SECRET_FILE}: removed (the update channel changed)`);
    }
  } catch (e) {
    log.error(`${UPDATE_SECRET_FILE} not updated (${errCode(e) || 'error'}) — self-update may fail to authenticate`);
  }
  log.info(plan.update.channel ? `self-update channel: ${plan.update.channel} ${plan.update.url}` : 'self-update: no channel (updates are off)');
  return plan.update;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return undefined;
    throw e;
  }
}

async function install(a: SetupArgs, log: Logger): Promise<void> {
  const manifest = validateManifest(await readJson(join(a.packageDir, MANIFEST_FILE)));
  log.info(`package Mk42 ${manifest.version} (mark42 ${manifest.source.mark42Commit}${manifest.source.dirty ? ' dirty' : ''}, upstream ${manifest.source.upstreamTag}) -> home ${a.home}`);
  await verifyPackage(a.packageDir, manifest, log);
  const pkgUpdate = await readPackageUpdate(a.packageDir, manifest);
  if (pkgUpdate) log.info(`update channel ${pkgUpdate.config.channel} (${pkgUpdate.config.url})${pkgUpdate.secret ? ', with channel credential' : ''}`);
  const paths = installPaths(a.home, manifest);
  // 처음 설치인지: registry.json이 없거나, 처음 설치가 중간에 끊겨 진행 표시가 남아 있으면(다시 돌려도 로그온 작업을 만들게)
  const pending = await readJson<{ fresh?: boolean }>(join(a.home, PENDING_FILE));
  const fresh = pending?.fresh ?? !existsSync(join(a.home, REGISTRY_FILE));
  const defaultHome = samePath(a.home, defaultMark42Home({ ...process.env, MARK42_HOME: undefined }));
  const app = manifest.components.find((c) => c.name === 'app')!;

  if (a.dryRun) {
    for (const c of manifest.components) log.info(`plan: ${c.name} ${c.version} -> ${targetFor(a.home, c).path}${existsSync(targetFor(a.home, c).path) ? ' (exists)' : ''}`);
    log.info(`plan: daemon ${paths.node} ${paths.daemonEntry} --home ${a.home} --pipe ${a.pipe}`);
    log.info(`plan: app ${upstreamVersionOf(app.version)} -> ${paths.appExe}; registry ${fresh ? 'new' : 'update'}`);
    log.info(`plan: update channel ${pkgUpdate ? `${pkgUpdate.config.channel}${pkgUpdate.secret ? ' + credential' : ''}` : '(keep the installed one)'}`);
    return;
  }

  // 관리자 권한으로 띄운 데몬은 일반 권한 창·통합 창이 쓸 수 없어요(파이프 무결성 수준) — 일반 권한으로 다시 실행하게
  if (await isElevated()) {
    throw new SetupUserError('Setup is running as administrator — run Setup.cmd normally (not «Run as administrator»)', setupText(uiLang, 'elevatedInstall'));
  }

  // 0. home을 나만 쓰는 폴더로 먼저 조여요(데몬이 처음 뜰 때 하는 것과 같은 일) — 실행 파일을 넣기 전에
  await fsp.mkdir(a.home, { recursive: true });
  await loadOrCreateAuthSecret(a.home, { log: (level, msg) => log[level](msg) });

  // 1. 버전 폴더·파일 복사 (데몬이 도는 중에도 돼요 — 새 버전 폴더라 지금 쓰는 파일과 겹치지 않아요)
  const outcomes: Record<string, InstallOutcome> = {};
  for (const c of manifest.components) {
    const src = join(a.packageDir, c.dir);
    const t = targetFor(a.home, c);
    if (t.kind === 'dir') outcomes[c.name] = await installDir(src, t.path, c, await componentFiles(a.packageDir, c), log);
    else {
      const files = await fsp.readdir(src);
      if (files.length !== 1) throw new Error(`component ${c.name} must hold exactly one file`);
      outcomes[c.name] = await installFile(join(src, files[0]!), t.path, files[0]!, log);
      if (c.name === 'extension') await keepOnlyVsix(t.path, files[0]!, log);
    }
  }
  await removeAsideFiles(dirname(paths.hubExe), HUB_EXE);
  // 엔진도 home\setup에 둬요 — 제거(설치 마법사가 이 사본을 임시 폴더로 옮겨 돌려요)와 나중 업데이트가 늘 최신 엔진을 쓰게
  const engine = join(a.packageDir, 'setup', SETUP_SCRIPT);
  if (existsSync(engine)) outcomes.setup = await installFile(engine, join(a.home, 'setup'), SETUP_SCRIPT, log);
  log.info(`components: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // 새 데몬이 적어도 뜨는지 먼저 봐요 — 안 뜨면 지금 데몬을 끄지 않고 멈춰요
  await preflightDaemon(paths.node, paths.daemonEntry, a.home);

  const autostart = new Autostart({
    action: { command: paths.node, args: autostartEntryArgs(paths.daemonEntry, { home: a.home, pipe: a.pipe }) },
    tmpDir: join(a.home, 'tmp'),
  });
  const prevTask = await autostart.currentAction();
  const task = decideTask({ noAutostart: !a.autostart, fresh, defaultHome, current: prevTask, home: a.home, pipe: a.pipe });

  // 2. 데몬 끄기 → 설정 반영(데몬이 registry.json을 쥐고 있어서 꺼진 뒤에) → 로그온 작업 → 다시 띄우기.
  //    도중에 실패하면 설정·작업을 되돌리고 원래 데몬을 다시 띄워요(창이 데몬 없이 남지 않게).
  const stopped = await stopDaemon(a.home, a.pipe, log);
  if (stopped !== 'none') log.info(`daemon stopped (${stopped}) — Mk42 windows keep running and reconnect`);

  const registryFile = join(a.home, REGISTRY_FILE);
  const backup = existsSync(registryFile) ? join(a.home, `${REGISTRY_FILE}.bak-setup-${timestampForFile()}`) : undefined;
  let registryWritten = false;
  let taskChanged = false;
  try {
    await atomicWriteFile(join(a.home, PENDING_FILE), `${JSON.stringify({ fresh, startedAt: new Date().toISOString() })}\n`);
    if (backup) {
      await fsp.copyFile(registryFile, backup);
      log.info(`registry backup: ${backup}`);
    }
    const registry = await Registry.load(a.home, { log: log.child('registry') });
    const mk42Data = a.mk42Data ?? join(homedir(), '.mk42');
    const change = applyInstallToSettings(registry.settings, {
      appVersion: upstreamVersionOf(app.version),
      appExe: paths.appExe,
      extensionDir: paths.extensionDir,
      mk42Data,
      fresh,
    });
    registryWritten = true;
    await registry.update((d) => {
      d.settings = change.settings;
    });
    for (const n of change.notes) log.info(`settings: ${n}`);
    // 시험 전용: 되돌리기 경로를 실제로 거쳐 보게(시험 home에서만 써요)
    if (process.env.MK42_SETUP_TEST_FAIL === 'after-registry') throw new Error('injected test failure (MK42_SETUP_TEST_FAIL)');

    if (task === 'create' || task === 'update') {
      taskChanged = true;
      await autostart.set(true);
      log.info(`logon task ${task === 'create' ? 'created' : 'updated'}: ${paths.node} ${paths.daemonEntry}`);
    } else if (task === 'leave-other') {
      log.warn('logon task Mark42\\mk42d runs another home/pipe — left as is');
    } else {
      log.info(`logon task left as is (${task === 'skip' ? '--no-autostart' : fresh ? 'not the default home' : 'it was off'}) — turn it on in the hub settings`);
    }

    // 시작 메뉴 «Mk42»는 사용자마다 하나라 기본 home 설치만 만들어요
    if (a.shortcut && defaultHome) await createStartMenuShortcut(paths.hubExe, a.home, process.env, log);
    else if (a.shortcut) log.info('start menu shortcut skipped (not the default home)');

    if (a.start || stopped !== 'none') await startDaemon(paths.node, paths.daemonEntry, a.home, a.pipe, log);
  } catch (e) {
    log.error(`install failed after the daemon was stopped: ${errMsg(e)} — rolling back settings and logon task`);
    await rollback({ a, backup, registryWritten, taskChanged, prevTask, stopped, paths, log });
    throw e;
  }

  const record: InstallRecord = {
    schema: 1,
    product: 'mark42',
    package: { version: manifest.version, createdAt: manifest.createdAt, source: manifest.source },
    installedAt: new Date().toISOString(),
    home: a.home,
    pipe: a.pipe,
    components: Object.fromEntries(
      manifest.components.map((c) => [c.name, { version: c.version, path: targetFor(a.home, c).path, treeHash: c.treeHash }]),
    ),
    update: await applyUpdateChannel(a.home, pkgUpdate, log),
  };
  await atomicWriteFile(join(a.home, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  await fsp.rm(join(a.home, PENDING_FILE), { force: true });

  await reportOldVersions(a.home, manifest, log);
  log.info(`Mk42 ${manifest.version} installed. Open «Mk42» from the Start menu (hub window).`);
}

async function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const r = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ]);
  return r.code === 0 && r.stdout.trim().toLowerCase() === 'true';
}

/** 데몬을 끈 뒤 실패: registry.json·로그온 작업을 설치 전으로, 원래 데몬(작업의 동작, 없으면 새 데몬)을 다시 띄워요. 모두 할 수 있는 만큼만. */
async function rollback(p: {
  a: SetupArgs;
  backup: string | undefined;
  registryWritten: boolean;
  taskChanged: boolean;
  prevTask: TaskAction | undefined;
  stopped: 'none' | 'shutdown' | 'killed';
  paths: ReturnType<typeof installPaths>;
  log: Logger;
}): Promise<void> {
  const { a, log } = p;
  const registryFile = join(a.home, REGISTRY_FILE);
  try {
    if (p.registryWritten && p.backup) await fsp.copyFile(p.backup, registryFile);
    else if (p.registryWritten) await fsp.rm(registryFile, { force: true });
    if (p.registryWritten) log.info('rollback: registry.json restored');
  } catch (e) {
    log.error(`rollback: registry.json not restored: ${errMsg(e)}`);
  }
  try {
    if (p.taskChanged && p.prevTask) await new Autostart({ action: p.prevTask, tmpDir: join(a.home, 'tmp') }).set(true);
    else if (p.taskChanged) await new Autostart({ action: { command: p.paths.node, args: [] } }).set(false);
    if (p.taskChanged) log.info('rollback: logon task restored');
  } catch (e) {
    log.error(`rollback: logon task not restored: ${errMsg(e)}`);
  }
  if (p.stopped === 'none' || (await pipeExists(a.pipe))) return;
  try {
    // 원래 작업이 이 home 것이면 그 데몬(옛 번들)을, 아니면 새로 깐 데몬을 띄워요 — --boot 없이(재개는 로그온 때만)
    const prev = p.prevTask && decideTask({ noAutostart: false, fresh: false, defaultHome: true, current: p.prevTask, home: a.home, pipe: a.pipe }) === 'update';
    if (prev && p.prevTask) {
      const [entry, ...rest] = p.prevTask.args;
      await startDaemon(p.prevTask.command, entry!, a.home, a.pipe, log, rest.filter((x) => x !== '--boot').filter((_, i, arr) => !isHomePipeArg(arr, i)));
    } else {
      await startDaemon(p.paths.node, p.paths.daemonEntry, a.home, a.pipe, log);
    }
    log.info('rollback: daemon running again');
  } catch (e) {
    log.error(`rollback: could not restart a daemon (${errMsg(e)}) — log off and on, or run setup again`);
  }
}

/** startDaemon이 --home·--pipe를 다시 붙여서, 원래 인자에서는 그 둘(과 값)을 빼요 */
function isHomePipeArg(args: string[], i: number): boolean {
  const a = args[i]!;
  const prev = args[i - 1];
  return a === '--home' || a === '--pipe' || prev === '--home' || prev === '--pipe' || a.startsWith('--home=') || a.startsWith('--pipe=');
}

/** 지금 설치본이 아닌 버전 폴더를 알려만 줘요(지우기는 사용자가 — 다른 버전 창이 아직 떠 있을 수 있어요) */
async function reportOldVersions(home: string, m: PackageManifest, log: Logger): Promise<void> {
  for (const c of m.components) {
    const t = targetFor(home, c);
    if (t.kind !== 'dir') continue;
    const parent = dirname(t.path);
    const others = (await fsp.readdir(parent).catch(() => [] as string[])).filter(
      (n) => !samePath(join(parent, n), t.path) && !n.endsWith('.partial'),
    );
    if (others.length) log.info(`older ${c.name} folders in ${parent}: ${others.join(', ')}`);
  }
}

// ---- uninstall ----

interface ProgramProcess {
  ProcessId: number;
  Name: string;
  /** 관리자 권한 프로세스는 일반 권한 조회에서 경로가 비어요(null) */
  ExecutablePath: string | null;
}

/**
 * home 아래 실행 파일로 도는 프로세스(Mk42 창·통합 창·데몬 node 등). 경로를 못 읽는(관리자 권한으로 뜬) Mk42.exe·mk42-hub.exe도
 * 넣어요 — 모르면 «사용 중»으로 봐요(창이 뜬 채로 지우지 않게). 경로는 환경 변수로 넘겨요(따옴표·주입 걱정 없게).
 */
async function programProcesses(home: string): Promise<ProgramProcess[]> {
  if (process.platform !== 'win32') return [];
  const r = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=$env:MK42_PREFIX; ' +
        'Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)) -or ' +
        "((-not $_.ExecutablePath) -and ($_.Name -ieq 'Mk42.exe' -or $_.Name -ieq 'mk42-hub.exe')) } | " +
        'Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
    ],
    { ...process.env, MK42_PREFIX: `${resolve(home).replace(/[\\/]+$/, '')}\\` },
  );
  if (r.code !== 0) throw new Error(`process list failed: ${r.stderr.trim()}`);
  const raw = r.stdout.trim();
  // 설치 마법사의 제거 프로그램(home\uninstall\unins000.exe — 첫 단계가 둘째 단계를 기다리며 떠 있어요)은 빼요
  const wizard = join(home, WIZARD_UNINSTALL_DIR);
  return ((raw ? [JSON.parse(raw)].flat() : []) as ProgramProcess[]).filter(
    (p) => p.ProcessId !== process.pid && !(p.ExecutablePath && isInside(p.ExecutablePath, wizard)),
  );
}

/** 이 home이 Mk42 설치 폴더인지 — 설치 기록이 이 home을 가리키거나, 설치 기록 전 판이면 설정·비밀 파일이 있어요 */
function looksLikeMark42Home(home: string, rec: InstallRecord | undefined): boolean {
  if (rec && typeof rec.home === 'string') return samePath(rec.home, home);
  return existsSync(join(home, REGISTRY_FILE)) && existsSync(join(home, 'auth.secret'));
}

/** --purge가 지우는 home 안 이름(데몬·통합 창·설치가 쓰는 것). 그 밖의 것은 남기고 알려요 */
const PURGE_NAMES = new Set(
  [
    ...PROGRAM_DIRS,
    INSTALL_RECORD,
    PENDING_FILE,
    REGISTRY_FILE,
    'auth.secret',
    'logs',
    'tmp',
    'roles',
    'cache',
    'verify',
    'data',
    'devext',
    'hub.json',
    'hub-host.json',
    'hub-window.json',
    'hub-edge',
    'hub-webview2',
    'window-identity.json',
    'mk42-code.ico',
    UPDATE_SECRET_FILE,
    UPDATES_DIR,
  ].map((n) => n.toLowerCase()),
);
const isPurgeName = (n: string) => PURGE_NAMES.has(n.toLowerCase()) || /^registry\.json\..+/i.test(n);

/** 설치 마법사가 오류 상자에 보여 줄 한 줄 — `MK42-ERROR ` 뒤가 사용자 문구예요(로그에도 남겨요) */
export const USER_ERROR_PREFIX = 'MK42-ERROR ';
/** 엔진이 시작할 때 한 번 알리는 로그 파일 자리 */
export const USER_LOG_PREFIX = 'MK42-LOG ';
/** 로그에는 영어(logMsg), MK42-ERROR 줄에는 사용자 문구(userMsg, 없으면 logMsg) — 줄 바꿈은 한 줄로 */
function userError(log: Logger, logMsg: string, userMsg: string = logMsg): void {
  log.error(logMsg);
  process.stdout.write(`${USER_ERROR_PREFIX}${userMsg.replace(/\s*\n\s*/g, ' ')}\n`);
}

/** 사용 중인 프로그램 — 로그는 영어, 오류 상자는 고른 언어(busyMessage, setup/messages.ts) */
function userBusyError(log: Logger, list: ProgramProcess[]): void {
  userError(log, `programs still running: ${[...new Set(list.map((p) => p.Name))].join(', ')} — close them and uninstall again`, busyMessage(uiLang, list));
}

/** 설치 기록의 데몬을 다시 띄워요(제거를 멈출 때) */
async function restartRecordedDaemon(a: SetupArgs, rec: InstallRecord | undefined, log: Logger): Promise<void> {
  const daemon = rec?.components?.daemon?.path;
  const runtime = rec?.components?.runtime?.path;
  if (!daemon || !runtime) {
    log.warn('no install record to restart the daemon from — log off and on, or open a Mk42 window');
    return;
  }
  try {
    await startDaemon(join(runtime, NODE_EXE), join(daemon, ...DAEMON_ENTRY), a.home, a.pipe, log);
  } catch (e) {
    log.error(`could not restart the daemon: ${errMsg(e)}`);
  }
}

async function uninstall(args: SetupArgs, log: Logger): Promise<number> {
  const rec = await readJson<InstallRecord>(join(args.home, INSTALL_RECORD)).catch(() => undefined);
  const recorded = args.pipeGiven ? undefined : rec?.pipe;
  const a: SetupArgs = typeof recorded === 'string' && recorded ? { ...args, pipe: recorded } : args;
  log.info(`uninstall ${a.home} (pipe ${a.pipe}${recorded ? ', from install.json' : ''})${a.check ? ' — check only' : a.purge ? ' — with settings and records' : ''}`);
  if (isInside(process.execPath, a.home)) {
    throw new Error(`this node (${process.execPath}) is inside ${a.home} and cannot remove itself — run uninstall from a copy outside the home`);
  }
  // 엉뚱한 폴더(오타·잘못된 MARK42_HOME)에서 고정 이름 폴더를 지우지 않게
  if (!looksLikeMark42Home(a.home, rec)) {
    userError(log, `${a.home} is not a Mk42 install folder (no install record or settings) — nothing removed`, setupText(uiLang, 'notHome', a.home));
    return 2;
  }
  // 사전 검사(--check)에서 먼저 걸러요 — 실제 제거 단계에서 처음 실패하지 않게
  if (await isElevated()) {
    throw new SetupUserError('Setup is running as administrator — uninstall normally (not «Run as administrator»)', setupText(uiLang, 'elevatedUninstall'));
  }
  const isDaemonNode = (p: ProgramProcess) => /^node\.exe$/i.test(p.Name) && !!p.ExecutablePath && isInside(p.ExecutablePath, join(a.home, 'runtime'));
  // 데몬(node)은 우리가 끄니까 빼고 봐요 — 창은 사용자가 닫아야 해요
  const busy = (await programProcesses(a.home)).filter((p) => !isDaemonNode(p));
  if (busy.length) {
    for (const p of busy) log.info(`running: ${p.Name} ${p.ProcessId} ${p.ExecutablePath ?? '(path hidden — elevated?)'}`);
    userBusyError(log, busy);
    return EXIT_BUSY;
  }
  if (a.check) {
    log.info(`ok to uninstall ${a.home}`);
    return 0;
  }

  const stopped = await stopDaemon(a.home, a.pipe, log);
  log.info(`daemon: ${stopped}`);
  const leftAll = await programProcesses(a.home);
  // 데몬 node는 파이프를 닫은 뒤 잠깐 더 살아 있을 수 있어요 — 창만 «사용 중»으로 보고, node는 끝날 때까지 조금 기다려요
  const left = leftAll.filter((p) => !isDaemonNode(p));
  if (!left.length && leftAll.length) await waitFor(async () => !(await programProcesses(a.home)).some(isDaemonNode), 10_000, 500);
  if (left.length) {
    for (const p of left) log.info(`running: ${p.Name} ${p.ProcessId} ${p.ExecutablePath ?? '(path hidden — elevated?)'}`);
    userBusyError(log, left);
    // 사전 검사 뒤에 창이 열렸어요 — 끈 데몬을 다시 띄워 창이 데몬 없이 남지 않게(아직 아무것도 안 지웠어요)
    if (stopped !== 'none') await restartRecordedDaemon(a, rec, log);
    return EXIT_BUSY;
  }

  // 로그온 작업: 이 home·pipe 것일 때만 지워요(다른 home의 작업은 그대로)
  const defaultHome = samePath(a.home, defaultMark42Home({ ...process.env, MARK42_HOME: undefined }));
  const autostart = new Autostart({ action: { command: process.execPath, args: [] }, tmpDir: join(a.home, 'tmp') });
  const task = await autostart.currentAction();
  if (task && decideTask({ noAutostart: false, fresh: false, defaultHome, current: task, home: a.home, pipe: a.pipe }) === 'update') {
    await autostart.set(false);
    log.info('logon task Mark42\\mk42d removed');
  } else if (task) {
    log.info('logon task Mark42\\mk42d runs another home/pipe — left as is');
  }

  if (defaultHome && process.env.APPDATA) {
    const lnk = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Mk42.lnk');
    if (existsSync(lnk)) {
      await fsp.rm(lnk, { force: true });
      log.info(`start menu shortcut removed: ${lnk}`);
    }
  }

  // 남는 앱 데이터 자리(끝 문구용) — 지우는 앱 항목의 user-data 폴더
  const appDataDirs: string[] = [];
  if (existsSync(join(a.home, REGISTRY_FILE))) {
    const registry = await Registry.load(a.home, { log: log.child('registry') });
    for (const app of registry.settings.apps) {
      if (isInside(app.exe, join(a.home, 'app')) && app.userDataDir && !appDataDirs.some((d) => samePath(d, dirname(app.userDataDir!)))) {
        appDataDirs.push(dirname(app.userDataDir));
      }
    }
  }
  if (!a.purge && existsSync(join(a.home, REGISTRY_FILE))) {
    const registry = await Registry.load(a.home, { log: log.child('registry') });
    const change = removeInstallFromSettings(registry.settings, a.home);
    if (change.notes.length) {
      await registry.update((d) => {
        d.settings = change.settings;
      });
      for (const n of change.notes) log.info(`settings: ${n}`);
    }
  }

  const failed: string[] = [];
  const remove = async (p: string) => {
    if (!existsSync(p)) return;
    try {
      await fsp.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      log.info(`removed ${p}`);
    } catch (e) {
      failed.push(p);
      log.error(`could not remove ${p}: ${errMsg(e)}`);
    }
  };
  for (const d of PROGRAM_DIRS) await remove(join(a.home, d));
  await remove(join(a.home, INSTALL_RECORD));
  await remove(join(a.home, PENDING_FILE));
  // 받아 둔 업데이트 설치 파일(수백 MB)은 프로그램이에요 — 설정이 아니라 늘 지워요. update.secret은 설정처럼 --purge 때만
  await remove(join(a.home, UPDATES_DIR));
  if (a.purge) {
    // 아는 것만 지워요(데몬·통합 창·설치가 쓰는 것). 설치 마법사의 제거 프로그램 폴더는 마법사가 끝에 지워요
    const leftover: string[] = [];
    for (const e of await fsp.readdir(a.home).catch(() => [] as string[])) {
      if (e.toLowerCase() === WIZARD_UNINSTALL_DIR) continue;
      if (isPurgeName(e)) await remove(join(a.home, e));
      else leftover.push(e);
    }
    if (leftover.length) log.info(`left in place (not known Mk42 files): ${leftover.join(', ')}`);
  }
  if (failed.length) {
    throw new SetupUserError(`some files could not be removed (in use?): ${failed.join(', ')} — remove them by hand`, setupText(uiLang, 'notRemoved', failed.join(', ')));
  }
  const appData = appDataDirs.length ? appDataDirs.join(', ') : 'the Mk42 user-data folder';
  log.info(
    a.purge
      ? `Mk42 removed with its settings and records (${a.home}). App data is kept: ${appData}.`
      : `Mk42 removed. Settings and records are kept in ${a.home}; app data is kept: ${appData}.`,
  );
  return 0;
}

async function status(a: SetupArgs, log: Logger): Promise<void> {
  const rec = await readJson<InstallRecord>(join(a.home, INSTALL_RECORD));
  log.info(rec ? `installed package ${rec.package.version} at ${rec.installedAt}` : `no ${INSTALL_RECORD} in ${a.home} (not installed by setup)`);
  if (rec) for (const [k, v] of Object.entries(rec.components)) log.info(`  ${k} ${v.version} ${v.path}${existsSync(v.path) ? '' : ' (missing!)'}`);
  let running = false;
  try {
    await verifyRunningDaemon(a.pipe, a.home, { timeoutMs: 2000 });
    running = true;
  } catch {
    // 꺼져 있음
  }
  log.info(`daemon on ${a.pipe}: ${running ? 'running' : 'not running'}`);
}

async function main(): Promise<number> {
  let a: SetupArgs;
  try {
    a = parseSetupArgs(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`${errMsg(e)}\n${USAGE}\n`);
    return 2;
  }
  if (a.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  uiLang = await setupLanguage(a.lang);
  // 제거는 home을 지울 수 있어서 로그를 임시 폴더에 써요
  const logFile = a.command === 'uninstall' ? join(tmpdir(), 'mk42-uninstall.log') : join(a.home, 'logs', 'mk42-setup.log');
  const log = createFileLogger({ file: logFile, level: 'info', echo: true });
  // 설치 마법사가 오류 상자에 이 로그 자리를 보여 줘요
  process.stdout.write(`${USER_LOG_PREFIX}${logFile}\n`);
  try {
    if (a.command === 'uninstall') return await uninstall(a, log);
    if (a.command === 'install') await install(a, log);
    else if (a.command === 'stop') log.info(`daemon on ${a.pipe}: ${await stopDaemon(a.home, a.pipe, log)}`);
    else await status(a, log);
    return 0;
  } catch (e) {
    log.error(`setup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    userError(log, errMsg(e), e instanceof SetupUserError ? e.userText : errMsg(e));
    return 1;
  }
}

main().then(
  (code) => {
    // 로그 파일 쓰기가 끝나게 잠깐 기다렸다가 끝내요
    setTimeout(() => process.exit(code), 100);
  },
  (e) => {
    process.stderr.write(`mk42-setup failed: ${errMsg(e)}\n`);
    process.exit(1);
  },
);
