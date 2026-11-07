// Mk42 자체 업데이트 (계약 C4, 2026-11-05). 설치 기록(<home>\install.json)의 update{channel,url,publicKey}가 다 있을 때만 켜져요.
// 시작 2분 뒤 한 번, 그 뒤 6시간마다, 그리고 창·통합 창의 «업데이트 확인»(update.check) 때:
//   <url>/<channel>/latest.json + latest.json.sig 받기 → **설치된 패키지의 공개 키**(서버 것 아님)로 Ed25519 서명 확인 → 필드 엄격 확인
//   → 설치된 판보다 높으면 <home>\updates\<file>.partial로 받기(진행 알림) → 크기·sha256 확인 → 이름 바꾸기, updates\의 다른 파일은 지워요.
//   → ready(창 하나가 «지금 설치할까요?»를 물어요). settings.update.autoInstall이면 묻지 않고 바로 설치해요.
// 설치 = 받은 설치 마법사를 sha256을 다시 맞춘 뒤 떨어진 프로세스로 `/SILENT /SUPPRESSMSGBOXES /NORESTART`. 마법사의 설치 엔진이
// `$/shutdown`으로 이 데몬을 끄고 새 판을 띄워요(Mk42 창·통합 창은 닫지 않아요 — 엔진의 기존 동작).
// 자격 증명: <home>\update.secret("user:password", 내부 채널만) → HTTP Basic. 로그·오류·알림에 내용을 쓰지 않고, 설정한 https 주소의 origin에만
// 보내요(리디렉션은 따라가지 않아요 — 다른 곳으로 Authorization이 새지 않게). https가 아닌 주소는 거절해요(시험만 loopback http 허용).
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { Mk42UpdateInstallResult, Mk42UpdateStatus } from '@mark42/protocol';
import { defaultMark42Home, samePath } from '@mark42/protocol/paths';
import { compareVersions } from './extensions.ts';
import { atomicWriteFile, errCode, renameWithRetry } from './fsutil.ts';
import { osUiLanguage, osUiLanguageSync, type UiLanguage } from './i18n.ts';
import { errMsg, type Logger } from './log.ts';

export const INSTALL_RECORD_FILE = 'install.json';
export const UPDATE_SECRET_FILE = 'update.secret';
export const UPDATES_DIR = 'updates';
export const LATEST_FILE = 'latest.json';
export const LATEST_SIG_FILE = 'latest.json.sig';
/**
 * 자동 설치를 시도한 판의 기록(<home>\updates\auto-install.json {version, sha256, at}). 설치 엔진이 데몬을 끈 뒤 실패하면 새로 뜬 데몬이
 * 같은 판·같은 파일을 찾아 2분마다 다시 자동 설치하는 고리에 빠져요 — 시작할 때 이 판이 아직 설치된 판보다 높으면 그 판(과 그보다 낮은 판)은
 * 자동 설치하지 않아요(ready로 두고 «설치»는 사용자가). 더 높은 판은 다시 자동 설치해요.
 */
export const AUTO_INSTALL_MARKER = 'auto-install.json';
/** 서버가 알리는 설치 파일 이름 — 경로 조각이 못 들어오게 */
export const SETUP_FILE_PATTERN = /^Mk42-Setup-[0-9.]+\.exe$/;
/** Inno Setup 조용한 설치 — 지난 설치의 작업 선택(로그온 자동 실행)은 Inno가 이어받아요 */
export const INSTALLER_ARGS: readonly string[] = ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];

const DEFAULT_FIRST_DELAY_MS = 2 * 60_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const MANIFEST_TIMEOUT_MS = 30_000;
/** 받기: 이만큼 아무 바이트도 안 오면 끊어요(전체 시간은 재지 않아요 — 300MB가 느린 회선에서도 끝나게) */
const DOWNLOAD_IDLE_MS = 60_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SIG_BYTES = 1024;
const MAX_NOTES_CHARS = 4000;
const PROGRESS_EVERY_MS = 500;
const DEFAULT_SIZE_LIMITS = { min: 1024 * 1024, max: 2 * 1024 * 1024 * 1024 };

/** 설치 기록의 업데이트 자리(검사를 마친 것) */
export interface UpdateConfig {
  channel: string;
  /** 채널 폴더들의 바탕 주소 — 늘 `/`로 끝나요 */
  url: string;
  /** SPKI PEM(Ed25519) */
  publicKey: string;
}

export interface LatestManifest {
  schema: 1;
  product: 'mk42';
  channel: string;
  version: string;
  appVersion?: string;
  publishedAt?: string;
  file: string;
  size: number;
  sha256: string;
  notes?: { ko?: string; en?: string };
}

const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/**
 * install.json `update`(또는 패키지 update.json) 검사 — 채널 이름, https 주소(사용자 정보·쿼리·조각 없음), Ed25519 공개 키.
 * 설치 엔진(setup/main.ts)도 같은 검사를 써요. 실패하면 이유 문자열.
 */
export function parseUpdateConfig(raw: unknown, opts: { allowLoopbackHttp?: boolean } = {}): UpdateConfig | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'no update settings' };
  const r = raw as Record<string, unknown>;
  if (r.channel == null && r.url == null && r.publicKey == null) return { error: 'no update channel' };
  if (typeof r.channel !== 'string' || !CHANNEL_PATTERN.test(r.channel)) return { error: 'bad update channel' };
  if (typeof r.url !== 'string' || r.url.length > 512) return { error: 'bad update url' };
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return { error: 'bad update url' };
  }
  const httpOk = opts.allowLoopbackHttp === true && u.protocol === 'http:' && isLoopbackHost(u.hostname);
  if (u.protocol !== 'https:' && !httpOk) return { error: 'update url must be https' };
  if (u.username || u.password || u.search || u.hash) return { error: 'update url must not carry credentials, a query or a fragment' };
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  if (typeof r.publicKey !== 'string' || r.publicKey.length > 4096) return { error: 'bad update public key' };
  try {
    if (publicKeyOf(r.publicKey).asymmetricKeyType !== 'ed25519') return { error: 'update public key is not Ed25519' };
  } catch {
    return { error: 'bad update public key' };
  }
  return { channel: r.channel, url: u.href, publicKey: r.publicKey };
}

function publicKeyOf(pem: string): KeyObject {
  return createPublicKey({ key: pem, format: 'pem' });
}

/** base64 서명(공백·줄바꿈 허용)이 이 바이트의 Ed25519 서명인지 */
export function verifyManifestSignature(bytes: Uint8Array, sigText: string, publicKeyPem: string): boolean {
  const t = sigText.trim();
  if (!/^[A-Za-z0-9+/=\s]+$/.test(t)) return false;
  const sig = Buffer.from(t.replace(/\s+/g, ''), 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, bytes, publicKeyOf(publicKeyPem), sig);
  } catch {
    return false;
  }
}

/** 서명을 맞춘 latest.json 바이트 → 필드 엄격 확인(모르는 필드는 무시) */
export function parseLatestManifest(
  bytes: Uint8Array,
  channel: string,
  limits: { min: number; max: number } = DEFAULT_SIZE_LIMITS,
): LatestManifest {
  const fail = (m: string): never => {
    throw new Error(`invalid ${LATEST_FILE}: ${m}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('not UTF-8 JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('not an object');
  const m = raw as Record<string, unknown>;
  if (m.schema !== 1) fail(`unsupported schema ${String(m.schema)}`);
  if (m.product !== 'mk42') fail('product is not mk42');
  if (m.channel !== channel) fail(`channel is ${String(m.channel)}, not ${channel}`);
  if (typeof m.version !== 'string' || !PACKAGE_VERSION_PATTERN.test(m.version)) fail('bad version');
  if (typeof m.file !== 'string' || !SETUP_FILE_PATTERN.test(m.file)) fail('bad file name');
  if (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < limits.min || m.size > limits.max) fail('bad size');
  if (typeof m.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(m.sha256)) fail('bad sha256');
  if (m.appVersion !== undefined && (typeof m.appVersion !== 'string' || m.appVersion.length > 100)) fail('bad appVersion');
  if (m.publishedAt !== undefined && (typeof m.publishedAt !== 'string' || m.publishedAt.length > 40)) fail('bad publishedAt');
  let notes: LatestManifest['notes'];
  if (m.notes !== undefined) {
    if (typeof m.notes !== 'object' || m.notes === null || Array.isArray(m.notes)) fail('bad notes');
    const n = m.notes as Record<string, unknown>;
    notes = {};
    for (const k of ['ko', 'en'] as const) {
      if (n[k] === undefined) continue;
      if (typeof n[k] !== 'string') fail(`bad notes.${k}`);
      notes[k] = (n[k] as string).slice(0, MAX_NOTES_CHARS);
    }
  }
  return {
    schema: 1,
    product: 'mk42',
    channel,
    version: m.version as string,
    ...(m.appVersion !== undefined ? { appVersion: m.appVersion as string } : {}),
    ...(m.publishedAt !== undefined ? { publishedAt: m.publishedAt as string } : {}),
    file: m.file as string,
    size: m.size as number,
    sha256: (m.sha256 as string).toLowerCase(),
    ...(notes ? { notes } : {}),
  };
}

/** update.secret 내용 → Basic 헤더 값. 형식이 틀리면 undefined(내용은 어디에도 쓰지 않아요) */
export function basicAuthHeader(secret: string): string | undefined {
  const t = (secret.charCodeAt(0) === 0xfeff ? secret.slice(1) : secret).trim();
  if (t.length > 512 || !/^[^:\r\n]+:[^\r\n]+$/.test(t)) return undefined;
  return `Basic ${Buffer.from(t, 'utf8').toString('base64')}`;
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SpawnedInstaller {
  /** 설치기가 끝났을 때(데몬이 아직 살아 있으면 — 엔진이 실패했거나 사용자가 취소) */
  onExit(cb: (code: number | null) => void): void;
}

export interface Mk42UpdaterOptions {
  home: string;
  log?: Logger;
  fetch?: FetchLike;
  now?: () => number;
  timers?: Timers;
  /** settings.update.autoInstall — 읽을 때마다 */
  autoInstall?: () => boolean;
  /** 설치기 띄우기(시험에서 바꿔 끼워요). 기본: 떨어진 프로세스, 창 보임 */
  spawnInstaller?: (exe: string, args: string[]) => Promise<SpawnedInstaller>;
  onChange?: (s: Mk42UpdateStatus) => void;
  /** 알림 문구 언어(기본: Windows 표시 언어) */
  lang?: () => UiLanguage;
  /** 시험 전용: http://127.0.0.1·localhost 주소 허용 */
  allowLoopbackHttp?: boolean;
  sizeLimits?: { min: number; max: number };
  firstDelayMs?: number;
  intervalMs?: number;
  downloadIdleMs?: number;
}

interface ReadyUpdate {
  manifest: LatestManifest;
  file: string;
}

/** 기본 설치기 띄우기 — 떨어진 프로세스(데몬이 꺼져도 계속), 창은 보여요(Inno 진행 창) */
export async function spawnDetachedInstaller(exe: string, args: string[]): Promise<SpawnedInstaller> {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  child.unref();
  return { onExit: (cb) => void child.once('exit', (code) => cb(code)) };
}

export class Mk42Updater {
  #opts: Mk42UpdaterOptions;
  #log: Logger | undefined;
  #fetch: FetchLike;
  #timers: Timers;
  #now: () => number;
  #status: Mk42UpdateStatus = { state: 'disabled', current: 'unknown' };
  #ready: ReadyUpdate | undefined;
  #checking: Promise<Mk42UpdateStatus> | undefined;
  #downloading: Promise<void> | undefined;
  #installing = false;
  /** 지금 도는 확인이 ready에서 시작했는지 — 그 동안에도 받아 둔 판은 설치할 수 있어요 */
  #checkFromReady = false;
  /** 지난 실행에서 자동 설치가 끝나지 않은 판(시작할 때 auto-install.json에서) */
  #failedAuto: { version: string; sha256?: string } | undefined;
  #timer: unknown;
  #closed = false;
  #lastProgressAt = 0;

  constructor(opts: Mk42UpdaterOptions) {
    this.#opts = opts;
    this.#log = opts.log;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#timers = opts.timers ?? realTimers;
    this.#now = opts.now ?? Date.now;
  }

  get updatesDir(): string {
    return join(this.#opts.home, UPDATES_DIR);
  }

  /** 지난 실행의 반쯤 받은 파일을 치우고 설치 기록을 읽어 상태를 정한 뒤, 2분 뒤 한 번·그 뒤 6시간마다 */
  async start(): Promise<void> {
    void osUiLanguage().catch(() => undefined);
    await this.#sweepPartials();
    const cfg = await this.#loadConfig();
    await this.#loadAutoInstallMarker(cfg.current);
    this.#applyConfig(cfg);
    if (cfg.config) this.#log?.info(`self-update: channel ${cfg.config.channel}, installed ${cfg.current}`);
    else this.#log?.info(`self-update disabled for now (${cfg.reason})`);
    // 꺼져 있어도 정해진 확인은 돌려요 — 설치 엔진은 새 데몬을 띄운 **뒤에** install.json을 써서, 막 뜬 데몬은 옛 기록을 읽을 수 있어요
    this.#schedule(this.#opts.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS);
  }

  /** 네트워크 없이 설치 기록만 다시 읽어 current·channel·disabled↔idle을 맞춘 상태(update.status) */
  async refreshStatus(): Promise<Mk42UpdateStatus> {
    if (!this.#checking && !this.#downloading && !this.#installing) {
      const s = this.#status.state;
      if (s === 'disabled' || s === 'idle' || s === 'error') this.#applyConfig(await this.#loadConfig());
    }
    return this.status();
  }

  #applyConfig(cfg: { config?: UpdateConfig; current: string }): void {
    if (this.#installStarted()) return;
    if (!cfg.config) {
      this.#ready = undefined;
      this.#set({ state: 'disabled', current: cfg.current }, true);
    } else if (this.#status.state === 'disabled' || this.#status.current !== cfg.current || this.#status.channel !== cfg.config.channel) {
      this.#set({ state: 'idle', current: cfg.current, channel: cfg.config.channel }, true);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  status(): Mk42UpdateStatus {
    return structuredClone(this.#status);
  }

  /** 지금 확인해요(서명 확인까지 기다리고, 받기는 이어서 백그라운드). 이미 확인 중이면 그 결과를 같이 기다려요 */
  check(): Promise<Mk42UpdateStatus> {
    this.#checking ??= this.#check().finally(() => (this.#checking = undefined));
    return this.#checking;
  }

  /** 받은 판의 받기가 끝날 때까지(시험·자동 설치용) */
  async whenIdle(): Promise<void> {
    await this.#checking;
    await this.#downloading;
  }

  /** 받아 둔 설치 파일을 sha256을 다시 맞춘 뒤 띄워요 */
  install(): Promise<Mk42UpdateInstallResult> {
    return this.#install(false);
  }

  /** 설치를 시작했거나(installing) 시작하는 중(sha256 다시 맞추는 중) — 확인·설정 반영이 상태를 덮지 않게 */
  #installStarted(): boolean {
    return this.#installing || this.#status.state === 'installing';
  }

  async #install(auto: boolean): Promise<Mk42UpdateInstallResult> {
    if (this.#installStarted()) return { started: false, error: 'an update is already being installed' };
    const r = this.#ready;
    // ready에서 시작한 확인이 도는 중(checking)이어도 받아 둔 판은 설치해요 — 그 확인은 installing을 덮지 않아요
    const readyNow = this.#status.state === 'ready' || (this.#status.state === 'checking' && this.#checkFromReady);
    if (!r || !readyNow) return { started: false, error: 'no downloaded update is ready' };
    this.#installing = true;
    try {
      if (!(await this.#fileMatches(r.file, r.manifest))) {
        this.#ready = undefined;
        await fsp.rm(r.file, { force: true }).catch(() => undefined);
        this.#log?.warn(`self-update: ${r.manifest.file} changed after it was verified — removed`);
        this.#set({ state: 'error', error: 'the downloaded installer changed after it was verified; it was removed', latest: r.manifest.version });
        return { started: false, error: 'the downloaded installer changed after it was verified' };
      }
      const args = [...INSTALLER_ARGS, `/LOG=${join(this.#opts.home, 'logs', 'mk42-update-setup.log')}`];
      // 기본 home이 아니면 설치 위치를 알려 줘요(마법사의 {param:MK42HOME})
      if (!samePath(this.#opts.home, defaultMark42Home({ ...process.env, MARK42_HOME: undefined }))) args.push(`/MK42HOME=${this.#opts.home}`);
      // 자동 설치는 띄우기 전에 기록해요 — 기록을 못 남기면 띄우지 않아요(엔진이 데몬을 끈 뒤 실패하면 끝없이 되풀이할 수 있어서)
      if (auto) await this.#writeAutoInstallMarker(r.manifest);
      const child = await (this.#opts.spawnInstaller ?? spawnDetachedInstaller)(r.file, args);
      this.#log?.info(`self-update: started installer ${r.manifest.file} (${r.manifest.version}) — the setup engine will restart this daemon`);
      this.#set({ state: 'installing', latest: r.manifest.version, error: undefined, progress: undefined });
      child.onExit((code) => {
        if (this.#closed || this.#status.state !== 'installing') return;
        // 데몬이 아직 살아 있어요 — 엔진이 데몬을 끄기 전에 멈췄거나(사용자 취소·실패) 되돌렸어요
        this.#log?.warn(`self-update: installer exited with code ${String(code)} while this daemon kept running`);
        this.#set({ state: 'ready', error: `the installer exited with code ${String(code)}` });
      });
      return { started: true };
    } catch (e) {
      if (auto && errCode(e) === 'MK42_AUTO_MARKER') {
        this.#log?.warn(`self-update: ${errMsg(e)} — not installing automatically`);
        this.#set({ state: 'ready', error: `automatic install skipped (${errMsg(e)}); install it manually`.slice(0, 300) });
        return { started: false, error: errMsg(e) };
      }
      this.#log?.error(`self-update: could not start the installer: ${errMsg(e)}`);
      this.#set({ state: 'ready', error: `could not start the installer (${errMsg(e)})`.slice(0, 300) });
      return { started: false, error: errMsg(e) };
    } finally {
      this.#installing = false;
    }
  }

  // ---- 내부 ----

  #schedule(ms: number): void {
    if (this.#closed) return;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      void this.check()
        .catch((e) => this.#log?.warn(`self-update check failed: ${errMsg(e)}`))
        .finally(() => this.#schedule(this.#opts.intervalMs ?? DEFAULT_INTERVAL_MS));
    }, ms);
  }

  #set(patch: Partial<Mk42UpdateStatus>, replace = false): void {
    const next: Mk42UpdateStatus = replace ? ({ ...patch } as Mk42UpdateStatus) : { ...this.#status, ...patch };
    for (const k of Object.keys(next) as (keyof Mk42UpdateStatus)[]) if (next[k] === undefined) delete next[k];
    if (JSON.stringify(next) === JSON.stringify(this.#status)) return;
    this.#status = next;
    try {
      this.#opts.onChange?.(structuredClone(next));
    } catch (e) {
      this.#log?.warn(`self-update change listener failed: ${errMsg(e)}`);
    }
  }

  async #loadConfig(): Promise<{ config?: UpdateConfig; current: string; reason?: string }> {
    let rec: { package?: { version?: unknown }; update?: unknown } | undefined;
    try {
      rec = JSON.parse(await fsp.readFile(join(this.#opts.home, INSTALL_RECORD_FILE), 'utf8')) as typeof rec;
    } catch (e) {
      return { current: 'unknown', reason: errCode(e) === 'ENOENT' ? `no ${INSTALL_RECORD_FILE} (not installed by setup)` : `${INSTALL_RECORD_FILE} unreadable` };
    }
    const v = rec?.package?.version;
    const current = typeof v === 'string' && PACKAGE_VERSION_PATTERN.test(v) ? v : 'unknown';
    if (current === 'unknown') return { current, reason: `${INSTALL_RECORD_FILE} has no package version` };
    const cfg = parseUpdateConfig(rec?.update, { allowLoopbackHttp: this.#opts.allowLoopbackHttp });
    if ('error' in cfg) return { current, reason: cfg.error };
    return { config: cfg, current };
  }

  /** update.secret → Basic 헤더(없으면 undefined). 내용은 로그에 쓰지 않아요 */
  async #authHeader(): Promise<string | undefined> {
    let text: string;
    try {
      text = await fsp.readFile(join(this.#opts.home, UPDATE_SECRET_FILE), 'utf8');
    } catch (e) {
      if (errCode(e) !== 'ENOENT') this.#log?.warn(`self-update: ${UPDATE_SECRET_FILE} not readable (${errCode(e) || 'error'})`);
      return undefined;
    }
    const h = basicAuthHeader(text);
    if (!h) this.#log?.warn(`self-update: ${UPDATE_SECRET_FILE} is not in user:password form — ignored`);
    return h;
  }

  async #get(cfg: UpdateConfig, url: URL, auth: string | undefined, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { 'cache-control': 'no-cache', 'user-agent': `Mk42-updater/${this.#status.current}` };
    // 설정한 주소의 origin에만 자격 증명을 실어요
    if (auth && url.origin === new URL(cfg.url).origin) headers.authorization = auth;
    const res = await this.#fetch(url.href, { headers, redirect: 'error', signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const hint = res.status === 401 || res.status === 403 ? ' (check update.secret)' : res.status === 404 ? ' (nothing published on this channel)' : '';
      throw new Error(`${url.pathname} answered HTTP ${res.status}${hint}`);
    }
    return res;
  }

  async #readCapped(res: Response, max: number, what: string): Promise<Uint8Array> {
    const len = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(len) && len > max) throw new Error(`${what} is too large`);
    const chunks: Uint8Array[] = [];
    let n = 0;
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${what} is too large`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async #fetchLatest(cfg: UpdateConfig): Promise<LatestManifest> {
    const auth = await this.#authHeader();
    const base = new URL(`${cfg.channel}/`, cfg.url);
    const signal = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
    const [bytes, sig] = await Promise.all([
      this.#get(cfg, new URL(LATEST_FILE, base), auth, signal).then((r) => this.#readCapped(r, MAX_MANIFEST_BYTES, LATEST_FILE)),
      this.#get(cfg, new URL(LATEST_SIG_FILE, base), auth, signal).then((r) => this.#readCapped(r, MAX_SIG_BYTES, LATEST_SIG_FILE)),
    ]);
    if (!verifyManifestSignature(bytes, Buffer.from(sig).toString('latin1'), cfg.publicKey)) {
      throw new Error(`${LATEST_FILE} signature does not verify with the installed public key — ignored`);
    }
    return parseLatestManifest(bytes, cfg.channel, this.#opts.sizeLimits ?? DEFAULT_SIZE_LIMITS);
  }

  #notesFor(m: LatestManifest): string | undefined {
    const lang = (this.#opts.lang ?? osUiLanguageSync)();
    return m.notes?.[lang] ?? m.notes?.en ?? m.notes?.ko;
  }

  async #check(): Promise<Mk42UpdateStatus> {
    if (this.#installStarted()) return this.status();
    const cfg = await this.#loadConfig();
    // 기다리는 동안 설치가 시작됐으면 상태를 덮지 않아요(아래 await 뒤마다 같아요)
    if (this.#installStarted()) return this.status();
    if (!cfg.config) {
      this.#applyConfig(cfg);
      return this.status();
    }
    // 받는 중이면 그대로(같은 파일을 두 번 받지 않게)
    if (this.#downloading) return this.status();
    const before = this.#status;
    this.#checkFromReady = before.state === 'ready' && this.#ready !== undefined;
    try {
      return await this.#checkWith(cfg as { config: UpdateConfig; current: string }, before);
    } finally {
      this.#checkFromReady = false;
    }
  }

  async #checkWith(cfg: { config: UpdateConfig; current: string }, before: Mk42UpdateStatus): Promise<Mk42UpdateStatus> {
    this.#set({ state: 'checking', current: cfg.current, channel: cfg.config.channel, error: undefined, progress: undefined });
    let m: LatestManifest;
    try {
      m = await this.#fetchLatest(cfg.config);
    } catch (e) {
      const error = errMsg(e).slice(0, 300);
      this.#log?.warn(`self-update check failed: ${error}`);
      if (this.#installStarted()) return this.status();
      // 이미 받아 둔 판은 그대로 설치할 수 있어요
      if (this.#ready && before.state === 'ready') this.#set({ state: 'ready', error, checkedAt: new Date(this.#now()).toISOString() });
      else this.#set({ state: 'error', error, checkedAt: new Date(this.#now()).toISOString() });
      return this.status();
    }
    if (this.#installStarted()) return this.status();
    const checkedAt = new Date(this.#now()).toISOString();
    const notes = this.#notesFor(m);
    if (compareVersions(m.version, cfg.current) <= 0) {
      this.#ready = undefined;
      await this.#prune(undefined);
      if (this.#installStarted()) return this.status();
      this.#set({ state: 'idle', latest: m.version, notes, checkedAt }, false);
      return this.status();
    }
    const file = join(this.updatesDir, m.file);
    if (this.#ready && this.#ready.manifest.version === m.version && this.#ready.manifest.sha256 === m.sha256) {
      this.#set({ state: 'ready', latest: m.version, notes, checkedAt, error: this.#autoBlockedError(m) });
      return this.status();
    }
    // 지난 실행에서 다 받은 파일이 있으면 다시 받지 않아요(서명한 sha256과 맞을 때만)
    const have = await this.#fileMatches(file, m);
    if (this.#installStarted()) return this.status();
    if (have) {
      await this.#becomeReady(m, file, notes, checkedAt);
      return this.status();
    }
    this.#set({ state: 'downloading', latest: m.version, notes, checkedAt, progress: { received: 0, total: m.size } });
    this.#downloading = this.#download(m, file, cfg.config)
      .then(() => this.#becomeReady(m, file, notes, checkedAt))
      .catch((e) => {
        const error = `download failed (${errMsg(e)})`.slice(0, 300);
        this.#log?.warn(`self-update ${m.version}: ${error}`);
        if (this.#installStarted()) return;
        this.#set({ state: 'error', error, progress: undefined });
      })
      .finally(() => (this.#downloading = undefined));
    return this.status();
  }

  async #becomeReady(m: LatestManifest, file: string, notes: string | undefined, checkedAt: string): Promise<void> {
    if (this.#installStarted()) return;
    this.#ready = { manifest: m, file };
    await this.#prune(m.file);
    if (this.#installStarted()) return;
    this.#log?.info(`self-update ${m.version} ready (${m.file}, ${(m.size / 1048576).toFixed(0)} MB, sha256 verified)`);
    const blocked = this.#autoBlockedError(m);
    this.#set({ state: 'ready', latest: m.version, notes, checkedAt, progress: undefined, error: blocked });
    if (this.#opts.autoInstall?.() === true) {
      if (blocked) {
        this.#log?.warn(`self-update: automatic install of ${m.version} did not finish last time — waiting for a manual install`);
        return;
      }
      this.#log?.info('self-update: settings.update.autoInstall is on — installing now');
      const r = await this.#install(true);
      if (!r.started) this.#log?.warn(`self-update auto install did not start: ${r.error ?? '?'}`);
    }
  }

  /** 자동 설치가 켜져 있고 이 판이 지난번에 자동 설치가 끝나지 않은 판(또는 그보다 낮은 판)이면 그 안내 한 줄 */
  #autoBlockedError(m: LatestManifest): string | undefined {
    const f = this.#failedAuto;
    if (!f || this.#opts.autoInstall?.() !== true) return undefined;
    if (compareVersions(m.version, f.version) > 0) return undefined;
    return `the automatic install of ${f.version} did not finish last time; install it manually`;
  }

  get autoInstallMarkerPath(): string {
    return join(this.updatesDir, AUTO_INSTALL_MARKER);
  }

  /** 시작할 때: 기록한 판이 설치된 판보다 높으면 그 자동 설치는 실패한 거예요. 같거나 낮으면(설치됨) 기록을 지워요 */
  async #loadAutoInstallMarker(current: string): Promise<void> {
    this.#failedAuto = undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(this.autoInstallMarkerPath, 'utf8'));
    } catch (e) {
      if (errCode(e) !== 'ENOENT') {
        // 읽을 수 없는 기록 — 지우고 넘어가요(다음 자동 설치 때 다시 써요)
        this.#log?.warn(`self-update: ${AUTO_INSTALL_MARKER} unreadable — removed`);
        await fsp.rm(this.autoInstallMarkerPath, { force: true }).catch(() => undefined);
      }
      return;
    }
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const version = typeof r.version === 'string' && PACKAGE_VERSION_PATTERN.test(r.version) ? r.version : undefined;
    // 설치된 판을 모르면 실패로 봐요(되풀이하지 않는 쪽)
    if (version && (current === 'unknown' || compareVersions(version, current) > 0)) {
      this.#failedAuto = { version, ...(typeof r.sha256 === 'string' ? { sha256: r.sha256 } : {}) };
      this.#log?.warn(`self-update: the automatic install of ${version} did not finish (installed: ${current}) — it will not be retried automatically`);
      return;
    }
    await fsp.rm(this.autoInstallMarkerPath, { force: true }).catch(() => undefined);
  }

  async #writeAutoInstallMarker(m: LatestManifest): Promise<void> {
    try {
      await atomicWriteFile(this.autoInstallMarkerPath, `${JSON.stringify({ version: m.version, sha256: m.sha256, at: new Date(this.#now()).toISOString() })}\n`);
    } catch (e) {
      throw Object.assign(new Error(`could not record the automatic install attempt (${errCode(e) || errMsg(e)})`), { code: 'MK42_AUTO_MARKER' });
    }
  }

  async #download(m: LatestManifest, file: string, cfg: UpdateConfig): Promise<void> {
    await fsp.mkdir(this.updatesDir, { recursive: true });
    const partial = `${file}.partial`;
    const ctrl = new AbortController();
    const idleMs = this.#opts.downloadIdleMs ?? DOWNLOAD_IDLE_MS;
    let idle = setTimeout(() => ctrl.abort(new Error('download stalled')), idleMs);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new Error('download stalled')), idleMs);
    };
    const fh = await fsp.open(partial, 'w');
    let ok = false;
    try {
      const res = await this.#get(cfg, new URL(m.file, new URL(`${cfg.channel}/`, cfg.url)), await this.#authHeader(), ctrl.signal);
      const len = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(len) && len !== m.size) throw new Error(`server sends ${len} bytes, ${LATEST_FILE} says ${m.size}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('empty response');
      const h = createHash('sha256');
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        received += value.byteLength;
        if (received > m.size) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`more bytes than ${LATEST_FILE} says (${m.size})`);
        }
        h.update(value);
        await fh.write(value);
        const t = this.#now();
        if (t - this.#lastProgressAt >= PROGRESS_EVERY_MS) {
          this.#lastProgressAt = t;
          this.#set({ progress: { received, total: m.size } });
        }
      }
      if (received !== m.size) throw new Error(`got ${received} bytes, expected ${m.size}`);
      if (h.digest('hex') !== m.sha256) throw new Error('sha256 does not match the signed manifest');
      await fh.sync();
      ok = true;
    } finally {
      clearTimeout(idle);
      await fh.close().catch(() => undefined);
      if (!ok) await fsp.rm(partial, { force: true }).catch(() => undefined);
    }
    await fsp.rm(file, { force: true });
    await renameWithRetry(partial, file);
  }

  async #fileMatches(file: string, m: LatestManifest): Promise<boolean> {
    try {
      const st = await fsp.stat(file);
      return st.isFile() && st.size === m.size && (await sha256File(file)) === m.sha256;
    } catch {
      return false;
    }
  }

  /** updates\에서 keep 말고 다 지워요(지난 판 설치 파일은 서버·이 PC 어디에도 쌓지 않아요) */
  async #prune(keep: string | undefined): Promise<void> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.updatesDir);
    } catch {
      return;
    }
    for (const n of names) {
      if (keep && n === keep) continue;
      // 자동 설치 기록은 시작할 때만 정리해요(새 판을 받아도 지난 실패를 잊지 않게)
      if (n === AUTO_INSTALL_MARKER || n.startsWith(`${AUTO_INSTALL_MARKER}.tmp-`)) continue;
      await fsp.rm(join(this.updatesDir, n), { recursive: true, force: true }).catch((e) => this.#log?.warn(`self-update: could not remove ${n}: ${errMsg(e)}`));
    }
  }

  async #sweepPartials(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.updatesDir);
    } catch {
      return;
    }
    for (const n of names.filter((x) => x.endsWith('.partial'))) await fsp.rm(join(this.updatesDir, n), { force: true }).catch(() => undefined);
  }
}
