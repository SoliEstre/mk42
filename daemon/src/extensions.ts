// 첫 실행 확장 설치 (WBS 3.4, R1) — Mark42가 만든 버전별 확장 폴더에 Claude·Codex 확장(한국어 Windows면 한국어 언어팩도, C2)을 깔아요.
// 사용자가 지정한 폴더(settings.apps[].extensionsDir)와 기본 ~/.vscode/extensions는 건드리지 않아요.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { win32 } from 'node:path';
import { errMsg, type Logger } from './log.ts';

export const KOREAN_LANGUAGE_PACK_ID = 'ms-ceintl.vscode-language-pack-ko';

/** 설치 한 번(확장 셋)에 기다리는 시간. Claude 확장은 100MB가 넘어요 */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * 설치본의 CLI 스크립트 — bin\code.cmd가 하는 그대로 `Code.exe <commit10>\resources\app\out\cli.js`예요.
 * 커밋 폴더(앞 10자 16진수)가 하나면 그 안, 옛 배치면 루트 resources 아래. 못 찾으면 undefined.
 */
export async function resolveCliScript(exe: string): Promise<string | undefined> {
  const root = win32.dirname(exe);
  const tail = ['resources', 'app', 'out', 'cli.js'];
  let dirs: string[] = [];
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^[0-9a-f]{10}$/i.test(d.name))
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  const candidates = [...dirs.map((d) => win32.join(root, d, ...tail)), win32.join(root, ...tail)];
  return candidates.find((c) => existsSync(c));
}

/**
 * `ids` 중 `extensionsDir`에 없는 것. 있음 = `<id>-<버전>[-<플랫폼>]` 폴더가 있고 `.obsolete`(지운 확장)에 없음.
 * 폴더가 없으면 전부 없음이에요.
 */
export async function missingExtensions(extensionsDir: string, ids: readonly string[]): Promise<string[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(extensionsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name.toLowerCase());
  } catch {
    return [...ids];
  }
  let obsolete = new Set<string>();
  try {
    const raw = JSON.parse(await fsp.readFile(win32.join(extensionsDir, '.obsolete'), 'utf8')) as Record<string, unknown>;
    obsolete = new Set(Object.keys(raw).map((k) => k.toLowerCase()));
  } catch {
    // 없거나 깨졌으면 무시
  }
  return ids.filter((id) => {
    const prefix = `${id.toLowerCase()}-`;
    return !names.some((n) => n.startsWith(prefix) && /^\d/.test(n.slice(prefix.length)) && !obsolete.has(n));
  });
}

/** Mark42 확장 ID(package.json publisher.name) — 패키징한 .vsix의 이름은 `mark42-<버전>.vsix` */
export const MARK42_EXTENSION_ID = 'mark42.mark42';

export interface VsixRef {
  path: string;
  version: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 설정 `extensionVsix`: `mark42-<x.y.z>.vsix` 파일, 또는 그런 파일이 든 폴더(가장 높은 버전). 없거나 이름이 맞지 않으면 undefined.
 */
export async function resolveVsix(setting: string): Promise<VsixRef | undefined> {
  const re = /^mark42-(\d+\.\d+\.\d+)\.vsix$/i;
  try {
    const st = await fsp.stat(setting);
    if (st.isFile()) {
      const m = re.exec(win32.basename(setting));
      return m ? { path: setting, version: m[1]! } : undefined;
    }
    let best: VsixRef | undefined;
    for (const name of await fsp.readdir(setting)) {
      const m = re.exec(name);
      if (m && (!best || compareVersions(m[1]!, best.version) > 0)) best = { path: win32.join(setting, name), version: m[1]! };
    }
    return best;
  } catch {
    return undefined;
  }
}

/** `extensionsDir`에 `<id>-<version>` 폴더가 있고 지운 확장(.obsolete)이 아닌지 */
export async function hasExtensionVersion(extensionsDir: string, id: string, version: string): Promise<boolean> {
  const folder = `${id}-${version}`.toLowerCase();
  let names: string[];
  try {
    names = (await fsp.readdir(extensionsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name.toLowerCase());
  } catch {
    return false;
  }
  if (!names.includes(folder)) return false;
  try {
    const raw = JSON.parse(await fsp.readFile(win32.join(extensionsDir, '.obsolete'), 'utf8')) as Record<string, unknown>;
    return !Object.keys(raw).some((k) => k.toLowerCase() === folder);
  } catch {
    return true;
  }
}

export function buildInstallArgs(
  cliScript: string,
  ids: readonly string[],
  userDataDir: string,
  extensionsDir: string,
  separation: { sharedDataDir?: string; agentPluginsDir?: string } = {},
): string[] {
  const args = [cliScript, '--user-data-dir', userDataDir, '--extensions-dir', extensionsDir];
  if (separation.sharedDataDir) args.push('--shared-data-dir', separation.sharedDataDir);
  if (separation.agentPluginsDir) args.push('--agent-plugins-dir', separation.agentPluginsDir);
  for (const id of ids) args.push('--install-extension', id);
  return args;
}

export interface RunResult {
  code: number | null;
  /** stdout·stderr 끝부분(로그용, 4KB까지) */
  output: string;
}
/** CLI 한 번 실행 — 테스트에서 가짜로 바꿔요 */
export type RunFn = (command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<RunResult>;

export const defaultRun: RunFn = (command, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env, timeout: timeoutMs });
    let output = '';
    const keep = (b: Buffer) => {
      output = (output + b.toString('utf8')).slice(-4096);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });

export interface ExtensionInstallerOptions {
  /** 깔아 둘 확장(launcher REQUIRED_EXTENSIONS — Claude·Codex. 언어 팩은 요청의 ids로) */
  ids: readonly string[];
  run?: RunFn;
  /** 데몬 환경(이미 VSCODE_*·ELECTRON_*를 지운 것). ELECTRON_RUN_AS_NODE=1을 더해요 */
  env: NodeJS.ProcessEnv;
  log?: Logger;
}

export interface EnsureRequest {
  exe: string;
  userDataDir: string;
  extensionsDir: string;
  /** Daemon/005: 창과 같은 공유 저장소·에이전트 플러그인 폴더로 (CLI가 평소 `~/.vscode-shared`·`~/.vscode/agent-plugins`를 열지 않게) */
  sharedDataDir?: string;
  agentPluginsDir?: string;
  /** 깔 확장(없으면 설치기 기본 ids) */
  ids?: readonly string[];
  /** 갤러리 대신 VSIX로 깔 확장 → 그 VSIX 경로를 마련하는 함수(판 덧층의 사이드로드) */
  sideload?: Readonly<Record<string, () => Promise<string>>>;
  /** 창이 기다리는 설치(한국어 언어 팩) — 같은 폴더의 차례에서 뒤에서 하는 설치(Codex·업데이트)보다 앞에 서요(돌고 있는 것은 기다려요) */
  priority?: boolean;
}

/**
 * 버전별 확장 폴더마다 빠진 확장을 한 번에 깔아요. 같은 폴더의 설치가 진행 중이면 그걸 기다려요(창 여러 개를 한꺼번에 띄울 때).
 * 실패해도 throw하지 않아요 — 창은 확장 없이라도 떠야 해서, 경고만 남기고 다음 실행 때 다시 시도해요.
 */
export class ExtensionInstaller {
  #opts: ExtensionInstallerOptions;
  #run: RunFn;
  #inFlight = new Map<string, Promise<void>>();
  #queues = new Map<string, { running: boolean; tasks: { priority: boolean; run: () => Promise<void> }[] }>();
  #vsixInFlight = new Map<string, Promise<boolean>>();

  constructor(opts: ExtensionInstallerOptions) {
    this.#opts = opts;
    this.#run = opts.run ?? defaultRun;
  }

  /**
   * Mark42 확장 .vsix — 그 버전이 확장 폴더에 없으면 `--install-extension <vsix> --force`로 깔아요(옛 버전은 VS Code가 치워요).
   * 쓸 수 있으면(이미 있거나 방금 깔림) true — 그 창에는 개발 경로를 붙이지 않아요. 실패는 false(개발 경로로 후퇴).
   */
  ensureVsix(req: EnsureRequest, vsix: VsixRef): Promise<boolean> {
    const key = `${req.extensionsDir.toLowerCase()}|vsix`;
    const running = this.#vsixInFlight.get(key);
    if (running) return running;
    // 이미 깔렸으면 바로 — 창 띄우기가 에이전트 확장 업데이트(CLI 설치) 차례를 기다리지 않게. 깔아야 할 때만 차례를 지키는데,
    // 창이 기다리니까 뒤에서 하는 설치(Codex 받기 뒤 설치·업데이트)보다 앞에 서요(2026-11-05)
    const p = hasExtensionVersion(req.extensionsDir, MARK42_EXTENSION_ID, vsix.version)
      .then((has) => has || this.#serial(req.extensionsDir.toLowerCase(), () => this.#ensureVsix(req, vsix), true))
      .finally(() => this.#vsixInFlight.delete(key));
    this.#vsixInFlight.set(key, p);
    return p;
  }

  async #ensureVsix(req: EnsureRequest, vsix: VsixRef): Promise<boolean> {
    const log = this.#opts.log;
    if (await hasExtensionVersion(req.extensionsDir, MARK42_EXTENSION_ID, vsix.version)) return true;
    const cli = await resolveCliScript(req.exe);
    if (!cli) {
      log?.warn(`Mark42 extension ${vsix.version} not installed: no cli.js next to ${req.exe}`);
      return false;
    }
    log?.info(`installing Mark42 extension ${vsix.version} into ${req.extensionsDir}`);
    const args = [...buildInstallArgs(cli, [], req.userDataDir, req.extensionsDir, req), '--install-extension', vsix.path, '--force'];
    try {
      const r = await this.#run(req.exe, args, { ...this.#opts.env, ELECTRON_RUN_AS_NODE: '1' }, INSTALL_TIMEOUT_MS);
      const ok = await hasExtensionVersion(req.extensionsDir, MARK42_EXTENSION_ID, vsix.version);
      if (ok) log?.info(`installed Mark42 extension ${vsix.version}`);
      else log?.warn(`Mark42 extension install exit=${r.code ?? 'killed'}; output: ${r.output.trim().slice(-600)}`);
      return ok;
    } catch (e) {
      log?.warn(`Mark42 extension install failed to start: ${errMsg(e)}`);
      return false;
    }
  }

  ensure(req: EnsureRequest): Promise<void> {
    const ids = req.ids ?? this.#opts.ids;
    // 같은 폴더·같은 확장 묶음이면 돌고 있는 설치를 같이 기다려요(언어 팩만 깔기가 Codex 받기를 기다리지 않게 묶음도 키에)
    const key = `${req.extensionsDir.toLowerCase()}|${ids.map((id) => id.toLowerCase()).sort().join(',')}`;
    const running = this.#inFlight.get(key);
    if (running) return running;
    const p = this.#ensure(req, ids).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, p);
    return p;
  }

  async #ensure(req: EnsureRequest, ids: readonly string[]): Promise<void> {
    const log = this.#opts.log;
    const dirKey = req.extensionsDir.toLowerCase();
    const priority = req.priority === true;
    const sideload = req.sideload ?? {};
    const galleryIds = ids.filter((id) => !Object.hasOwn(sideload, id));
    const sideIds = ids.filter((id) => Object.hasOwn(sideload, id));
    const noCli = (missing: readonly string[]) =>
      log?.warn(`extensions missing in ${req.extensionsDir} (${missing.join(', ')}), but no cli.js next to ${req.exe}; not installed`);
    const work: Promise<void>[] = [];
    if (galleryIds.length > 0) {
      // 갤러리 설치는 부른 그 순간 차례를 잡아요(빠진 것은 차례가 오면 봐요 — 기다리는 동안 다른 설치가 깔았을 수 있어요)
      work.push(
        this.#serial(
          dirKey,
          async () => {
            const missing = await missingExtensions(req.extensionsDir, galleryIds);
            if (missing.length === 0) return;
            const cli = await resolveCliScript(req.exe);
            if (!cli) return void noCli(missing);
            log?.info(`installing extensions into ${req.extensionsDir}: ${missing.join(', ')}`);
            await this.#install(req, buildInstallArgs(cli, missing, req.userDataDir, req.extensionsDir, req), missing);
          },
          priority,
        ),
      );
    }
    // VSIX 받기(Codex 약 600MB)는 차례 밖에서 — 받는 동안 Mark42 확장·언어 팩 설치가 막히지 않게. CLI 설치만 차례를 지켜요(2026-11-05)
    if (sideIds.length > 0) {
      work.push(
        (async () => {
          const missing = await missingExtensions(req.extensionsDir, sideIds);
          if (missing.length === 0) return;
          const cli = await resolveCliScript(req.exe);
          if (!cli) return void noCli(missing);
          await Promise.all(
            missing.map(async (id) => {
              let vsix: string;
              try {
                vsix = await sideload[id]!();
              } catch (e) {
                log?.warn(`extension ${id}: VSIX not prepared (${errMsg(e)}); not installed`);
                return;
              }
              await this.#serial(
                dirKey,
                async () => {
                  if ((await missingExtensions(req.extensionsDir, [id])).length === 0) return;
                  log?.info(`installing ${id} into ${req.extensionsDir} from ${vsix}`);
                  await this.#install(req, [...buildInstallArgs(cli, [], req.userDataDir, req.extensionsDir, req), '--install-extension', vsix, '--force'], [id]);
                },
                priority,
              );
            }),
          );
        })(),
      );
    }
    await Promise.all(work);
  }

  async #install(req: EnsureRequest, args: string[], ids: readonly string[]): Promise<void> {
    const log = this.#opts.log;
    try {
      const r = await this.#run(req.exe, args, { ...this.#opts.env, ELECTRON_RUN_AS_NODE: '1' }, INSTALL_TIMEOUT_MS);
      const still = await missingExtensions(req.extensionsDir, ids);
      if (r.code === 0 && still.length === 0) log?.info(`installed extensions: ${ids.join(', ')}`);
      else log?.warn(`extension install exit=${r.code ?? 'killed'}, still missing: ${still.join(', ') || '-'}; output: ${r.output.trim().slice(-600)}`);
    } catch (e) {
      log?.warn(`extension install failed to start: ${errMsg(e)}`);
    }
  }

  /**
   * 에이전트 확장을 `latest`로 올려요 — 확장 폴더의 가장 높은 버전이 그보다 낮을 때만 설치 인자(VSIX 경로 또는 갤러리 ID)를 마련해
   * `--install-extension <인자> --force`(떠 있는 창은 그대로, 새 버전은 창의 «업데이트 적용» 때). 받기(Codex 약 600MB)는 차례 밖에서,
   * CLI 설치만 같은 폴더의 다른 설치와 겹치지 않게 차례를 지켜요.
   */
  async updateExtension(req: EnsureRequest, id: string, latest: string, installArg: () => Promise<string>): Promise<ExtensionUpdateResult> {
    const before = await newestInstalledVersion(req.extensionsDir, id);
    if (before && compareVersions(before, latest) >= 0) return { status: 'current', installed: before };
    const cli = await resolveCliScript(req.exe);
    if (!cli) return { status: 'failed', installed: before, error: `no cli.js next to ${req.exe}` };
    let arg: string;
    try {
      arg = await installArg();
    } catch (e) {
      return { status: 'failed', installed: before, error: `install source not prepared (${errMsg(e)})` };
    }
    return this.#serial(req.extensionsDir.toLowerCase(), () => this.#updateExtension(req, cli, id, latest, arg));
  }

  /**
   * 같은 확장 폴더의 CLI 설치(빠진 확장 깔기·사이드로드 올리기)를 한 번에 하나씩. priority(창이 기다리는 설치)는 기다리는 일반 설치보다
   * 앞에 서요 — 돌고 있는 설치는 끝까지 기다려요(같은 폴더의 extensions.json을 두 CLI가 같이 쓰지 않게).
   */
  #serial<T>(key: string, fn: () => Promise<T>, priority = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let q = this.#queues.get(key);
      if (!q) {
        q = { running: false, tasks: [] };
        this.#queues.set(key, q);
      }
      const task = { priority, run: () => Promise.resolve().then(fn).then(resolve, reject) };
      const at = priority ? q.tasks.findIndex((t) => !t.priority) : -1;
      if (at >= 0) q.tasks.splice(at, 0, task);
      else q.tasks.push(task);
      this.#pump(key, q);
    });
  }

  #pump(key: string, q: { running: boolean; tasks: { priority: boolean; run: () => Promise<void> }[] }): void {
    if (q.running) return;
    const next = q.tasks.shift();
    if (!next) {
      if (this.#queues.get(key) === q) this.#queues.delete(key);
      return;
    }
    q.running = true;
    void next.run().finally(() => {
      q.running = false;
      this.#pump(key, q);
    });
  }

  async #updateExtension(req: EnsureRequest, cli: string, id: string, latest: string, arg: string): Promise<ExtensionUpdateResult> {
    const log = this.#opts.log;
    // 차례를 기다리는 동안 다른 설치(Mk42 자체 자동 업데이트 포함)가 먼저 올렸을 수 있어요
    const before = await newestInstalledVersion(req.extensionsDir, id);
    if (before && compareVersions(before, latest) >= 0) return { status: 'current', installed: before };
    log?.info(`updating ${id} ${before ?? '(none)'} -> ${latest} in ${req.extensionsDir}`);
    try {
      const r = await this.#run(
        req.exe,
        [...buildInstallArgs(cli, [], req.userDataDir, req.extensionsDir, req), '--install-extension', arg, '--force'],
        { ...this.#opts.env, ELECTRON_RUN_AS_NODE: '1' },
        INSTALL_TIMEOUT_MS,
      );
      const after = await newestInstalledVersion(req.extensionsDir, id);
      // 갤러리 ID로 깔면 이 앱에서 돌 수 있는 가장 높은 판이 들어와요 — latest보다 낮아도 올라갔으면 업데이트
      if (after && (!before || compareVersions(after, before) > 0)) {
        log?.info(`updated ${id} to ${after}`);
        return { status: 'updated', installed: after, previous: before };
      }
      const detail = `exit=${r.code ?? 'killed'}; output: ${r.output.trim().slice(-600)}`;
      log?.warn(`${id} update to ${latest} not installed: ${detail}`);
      return { status: 'failed', installed: after ?? before, error: detail };
    } catch (e) {
      return { status: 'failed', installed: before, error: `install failed to start (${errMsg(e)})` };
    }
  }
}

export interface ExtensionUpdateResult {
  status: 'current' | 'updated' | 'failed';
  /** 확장 폴더에서 가장 높은(지워질 예정이 아닌) 버전 */
  installed?: string;
  previous?: string;
  error?: string;
}

/**
 * 확장 폴더에서 그 확장의 가장 높은 버전(`<id>-<버전>` 또는 `<id>-<버전>-<플랫폼>` 폴더, `.obsolete`에 든 것은 빼요). 없으면 undefined.
 */
export async function newestInstalledVersion(extensionsDir: string, id: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await fsp.readdir(extensionsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name.toLowerCase());
  } catch {
    return undefined;
  }
  let obsolete = new Set<string>();
  try {
    const raw = JSON.parse(await fsp.readFile(win32.join(extensionsDir, '.obsolete'), 'utf8')) as Record<string, unknown>;
    obsolete = new Set(Object.keys(raw).map((k) => k.toLowerCase()));
  } catch {
    // 없거나 깨졌으면 무시
  }
  const prefix = `${id.toLowerCase()}-`;
  let best: string | undefined;
  for (const n of names) {
    if (!n.startsWith(prefix) || obsolete.has(n)) continue;
    const m = /^(\d+(?:\.\d+)*)(?:-[a-z0-9-]+)?$/.exec(n.slice(prefix.length));
    if (m && (!best || compareVersions(m[1]!, best) > 0)) best = m[1]!;
  }
  return best;
}
