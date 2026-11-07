// 에이전트 확장 업데이트 (Mk42). 데몬이 시작 몇 분 뒤와 6시간마다, 그리고 창의 «업데이트 확인» 요청 때 최신 정식판을 확인해
// 더 높으면(또는 빠졌으면) Mk42 확장 폴더에 깔아요. 떠 있는 창은 그대로 옛 버전을 쓰고, 창의 «업데이트 적용» 때 새 버전으로 바뀌어요.
// - Claude Code·Codex: Open VSX(Mk42 갤러리)에서 받되 **검증한 뒤에만** 깔아요(extVerify.ts) — 받은 VSIX를 시험 폴더에 깔아
//   해시하고(ID·버전도 확인), 같은 버전의 기준 해시(ReferenceSource)와 같으면 **그 파일**로 깔아요(받은 바이트의 sha256을 고정해 두고
//   깔기 직전에 다시 확인). 기준이 아직 없으면 깔지 않고 사용자 확인(면책)을 기다리는데, 기다리는 동안에도 확인할 때마다 기준을 다시 찾아서
//   생기면 그때 대조해요(같으면 깔고 다르면 막아요). 다르면 막아요. 시험 폴더에 깔리지도 않는 파일은 실패예요(확인 대상 아님).
//   Mk42 앱 자체의 확장 자동 업데이트는 꺼요(검증을 건너뛰지 않게 — userData.ts MANAGED_USER_SETTINGS).
// - 공급원은 판(edition)이 바꿀 수 있어요 — verify가 false인 공급원은 출처 자체를 기준으로 봐요.
// 확장마다 확인은 한 번에 하나(같은 파일을 두 확인이 건드리지 않게). 받은 VSIX(Claude 약 300MB, Codex 약 600MB)는 설치·차단 뒤 지우고,
// 확인을 기다리는 것만 하나 남겨요. 데몬이 다시 뜨면 남은 받은 파일·시험 폴더를 치워요.
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { AgentExtensionUpdate, ExtensionVerification } from '@mark42/protocol';
import { galleryTargetPlatform } from './edition.ts';
import { compareTrees, hashTree, stageInstallAndHash, type TreeHashes } from './extVerify.ts';
import { compareVersions, newestInstalledVersion, type EnsureRequest, type ExtensionUpdateResult } from './extensions.ts';
import { CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID } from './launcher.ts';
import { errMsg, type Logger } from './log.ts';
import { downloadOpenVsxVsix, latestOpenVsxVersion } from './gallery.ts';

const TARGET_PLATFORM = galleryTargetPlatform();
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_FIRST_DELAY_MS = 3 * 60_000;

/** Mk42 확장 폴더 설치 대상 + 앱 버전(엔진 호환 확인) */
export type AgentUpdateTarget = EnsureRequest & { appVersion?: string };

/**
 * 확장마다: 최신 정식판(없으면 undefined — 새 정식판 없음)과 그 버전의 VSIX 받기.
 * verify면 깔기 전에 기준 해시와 대조해요. 아니면 출처 자체가 기준(verification 표시).
 */
export interface AgentExtensionSource {
  id: string;
  verify: boolean;
  /** verify가 false일 때 붙이는 표시(기본 'marketplace' — 신뢰하는 출처) */
  verification?: ExtensionVerification;
  latest(appVersion: string | undefined): Promise<string | undefined>;
  download(version: string, cacheDir: string): Promise<string>;
}

/** 검증 기준 — 같은 버전의 기준 해시. 기준이 없으면 throw(검증 안 됨) */
export interface ReferenceSource {
  reference(id: string, version: string, platform: string): Promise<TreeHashes>;
}

function openVsxSource(id: string): AgentExtensionSource {
  return {
    id,
    verify: true,
    latest: (appVersion) => latestOpenVsxVersion(id, TARGET_PLATFORM, undefined, appVersion),
    download: (version, dir) => downloadOpenVsxVsix(id, version, TARGET_PLATFORM, dir),
  };
}

/** 기본 공급원: 두 확장 모두 Open VSX + 검증 */
export const AGENT_EXTENSION_SOURCES: readonly AgentExtensionSource[] = [openVsxSource(CLAUDE_EXTENSION_ID), openVsxSource(CODEX_EXTENSION_ID)];

/** 검증 — 시험에서 바꿔 끼워요. 기준이 없으면 reference가 throw해요(검증 안 됨) */
export interface ExtensionVerifier {
  reference(id: string, version: string): Promise<TreeHashes>;
  /** 후보 VSIX를 시험 폴더에 깔아 그 확장 ID·버전과 해시 */
  candidate(id: string, vsix: string): Promise<{ id?: string; version: string; files: TreeHashes }>;
  /** 이미 깔린 확장 폴더의 해시 */
  installed(folder: string): Promise<TreeHashes>;
}

export interface AgentExtensionUpdaterOptions {
  home: string;
  /** Mk42 확장 폴더 설치 대상(AppLauncher.mark42ExtensionTarget). 없으면 확인하지 않아요 */
  target: () => Promise<AgentUpdateTarget | undefined>;
  installer: { updateExtension(req: EnsureRequest, id: string, latest: string, installArg: () => Promise<string>): Promise<ExtensionUpdateResult> };
  /** 검증 기준(같은 버전의 기준 해시). 없으면 새 버전은 «검증 안 됨»(사용자 확인을 기다려요) */
  reference?: ReferenceSource;
  /** 시험 설치 CLI에 줄 환경(VSCODE_*·ELECTRON_* 뺀 것) */
  env?: NodeJS.ProcessEnv;
  verifier?: ExtensionVerifier;
  /** 상태가 바뀌었을 때(새 버전이 깔림·확인 기다림·막힘·깔린 판 검증 결과) — 창에 알려요 */
  onUpdated?: (ids: string[]) => void;
  log?: Logger;
  sources?: readonly AgentExtensionSource[];
  intervalMs?: number;
  firstDelayMs?: number;
}

export interface AgentUpdateCheck {
  /** 이 확장만(창은 제 에이전트만 — Claude 창이 Codex 600MB를 기다리지 않게). 없으면 모두 */
  ids?: readonly string[];
  /** 사용자가 누른 확인 — 정해진 확인과 달리 지난번에 깔리지 않은 같은 버전도 다시 해 봐요 */
  manual?: boolean;
}

/** 살펴본 Open VSX 판 — 받은 바이트의 sha256을 고정해 두고 깔기 직전에 다시 확인해요 */
interface Candidate {
  version: string;
  file: string;
  sha256: string;
  files: TreeHashes;
}

interface ExtState {
  update: AgentExtensionUpdate;
  /** 확인을 기다리는(검증 안 된) 후보 */
  candidate?: Candidate;
  /** 깔린 버전의 검증을 마친 버전 */
  checkedInstalled?: string;
}

export class AgentExtensionUpdater {
  #opts: AgentExtensionUpdaterOptions;
  #running = new Map<string, Promise<AgentExtensionUpdate[]>>();
  /** 확장마다 한 번에 하나 */
  #locks = new Map<string, Promise<unknown>>();
  /** 정해진 확인에서 깔리지 않은·막힌 버전 — 같은 버전이면 다시 받지 않아요(엔진 비호환 등으로 수백 MB를 6시간마다 받지 않게) */
  #failed = new Map<string, string>();
  #state = new Map<string, ExtState>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #seq = 0;

  constructor(opts: AgentExtensionUpdaterOptions) {
    this.#opts = opts;
  }

  /** 지난 실행이 남긴 받은 파일·시험 폴더를 치우고, 시작 몇 분 뒤 한 번, 그 뒤로 간격마다 */
  start(): void {
    void this.#sweepLeftovers();
    this.#schedule(this.#opts.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** 마지막으로 확인한 상태(네트워크 없이) */
  status(ids?: readonly string[]): AgentExtensionUpdate[] {
    return this.#sources(ids)
      .map((s) => this.#state.get(s.id)?.update)
      .filter((u): u is AgentExtensionUpdate => u !== undefined)
      .map((u) => ({ ...u }));
  }

  /** 지금 확인해요. 같은 확인이 이미 돌고 있으면 그 결과를 같이 기다려요 */
  check(req: AgentUpdateCheck = {}): Promise<AgentExtensionUpdate[]> {
    const sources = this.#sources(req.ids);
    const key = `${req.manual ? 'm' : 'a'}|${sources.map((s) => s.id).join(',')}`;
    let p = this.#running.get(key);
    if (!p) {
      p = this.#check(sources, req.manual === true).finally(() => this.#running.delete(key));
      this.#running.set(key, p);
    }
    return p;
  }

  /**
   * 사용자가 위험을 감수하고 검증되지 않은 버전을 깔아요 — 그 버전이 지금 확인을 기다리는 것일 때만. 깔기 전에 기준을 한 번 더 찾아서,
   * 그사이 기준이 생겼으면 대조해요(같으면 검증된 것으로 깔고, 다르면 막고 거절해요). 막힌 버전·다른 버전은 거절해요.
   */
  installUnverified(id: string, version: string): Promise<AgentExtensionUpdate> {
    return this.#withLock(id, async () => {
      const st = this.#state.get(id);
      const c = st?.candidate;
      if (!st || st.update.status !== 'pending' || !c || c.version !== version) throw new Error(`${id} ${version} is not waiting for approval`);
      const target = await this.#opts.target();
      if (!target) throw new Error('no Mark42 app to install into');
      const ref = await this.#tryReference(target, id, version);
      if (ref) {
        const u = await this.#decide(st, id, target, c, ref);
        this.#opts.onUpdated?.([id]);
        if (u.status === 'blocked') throw new Error(`${id} ${version} differs from the official build and was not installed`);
        return { ...u };
      }
      this.#opts.log?.warn(`agent extension ${id} ${version}: installing an UNVERIFIED build at the user's request`);
      const u = await this.#install(st, id, target, c, 'unverified');
      this.#opts.onUpdated?.([id]);
      return { ...u };
    });
  }

  #sources(ids?: readonly string[]): AgentExtensionSource[] {
    return (this.#opts.sources ?? AGENT_EXTENSION_SOURCES).filter((s) => !ids || ids.some((id) => id.toLowerCase() === s.id.toLowerCase()));
  }

  #withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const p = (this.#locks.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = p.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(id, tail);
    void tail.then(() => {
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    });
    return p;
  }

  #schedule(ms: number): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.check()
        .catch((e) => this.#opts.log?.warn(`agent extension update check failed: ${errMsg(e)}`))
        .finally(() => this.#schedule(this.#opts.intervalMs ?? DEFAULT_INTERVAL_MS));
    }, ms);
    this.#timer.unref?.();
  }

  #verifier(target: AgentUpdateTarget): ExtensionVerifier {
    if (this.#opts.verifier) return this.#opts.verifier;
    const env = this.#opts.env ?? {};
    const log = this.#opts.log;
    const home = this.#opts.home;
    return {
      reference: async (id, version) => {
        if (!this.#opts.reference) throw new Error(`no reference hashes for ${id} ${version} yet`);
        return this.#opts.reference.reference(id, version, TARGET_PLATFORM);
      },
      candidate: (id, vsix) => stageInstallAndHash({ exe: target.exe, installArg: vsix, id, workDir: join(home, 'verify'), env, log }),
      installed: (folder) => hashTree(folder),
    };
  }

  async #check(sources: readonly AgentExtensionSource[], manual: boolean): Promise<AgentExtensionUpdate[]> {
    const target = await this.#opts.target();
    if (!target) return [];
    const cacheDir = join(this.#opts.home, 'cache', 'vsix');
    const changed: string[] = [];
    const out: AgentExtensionUpdate[] = [];
    for (const src of sources) {
      const before = this.#state.get(src.id)?.update;
      const u = await this.#withLock(src.id, () => this.#checkOne(src, target, cacheDir, manual));
      if (
        !before ||
        before.status !== u.status ||
        before.installed !== u.installed ||
        before.pending !== u.pending ||
        before.installedVerification !== u.installedVerification ||
        u.status === 'updated'
      ) {
        changed.push(src.id);
      }
      out.push({ ...u });
    }
    if (changed.length > 0) this.#opts.onUpdated?.(changed);
    return out;
  }

  async #checkOne(src: AgentExtensionSource, target: AgentUpdateTarget, cacheDir: string, manual: boolean): Promise<AgentExtensionUpdate> {
    let st = this.#state.get(src.id);
    if (!st) {
      st = { update: { id: src.id, status: 'current' } };
      this.#state.set(src.id, st);
    }
    const installed = await newestInstalledVersion(target.extensionsDir, src.id);
    const installedVerification = await this.#installedVerification(src, target, st, installed, manual);
    const base = { id: src.id, installed, ...(installedVerification ? { installedVerification } : {}) };
    let latest: string | undefined;
    try {
      latest = await src.latest(target.appVersion);
    } catch (e) {
      return (st.update = { ...base, ...this.#pendingFields(st), status: st.candidate ? 'pending' : 'failed', error: `latest version not known (${errMsg(e)})` });
    }
    if (!latest && !installed) {
      // 깔린 것도 없고 깔 수 있는 정식판도 없어요(최신이 시험판이거나 이 앱보다 새 엔진을 요구) — «최신»이 아니라 실패로 알려요
      await this.#dropCandidate(st);
      return (st.update = { ...base, status: 'failed', error: `no release that runs on this app${target.appVersion ? ` (${target.appVersion})` : ''} yet` });
    }
    if (!latest || (installed && compareVersions(installed, latest) >= 0)) {
      await this.#dropCandidate(st);
      return (st.update = { ...base, ...(latest ? { latest } : {}), status: 'current' });
    }
    // 확인을 기다리는 같은 버전 — 다시 받지 않고, 그사이 기준이 생겼는지만 다시 봐요
    if (st.candidate && st.candidate.version === latest) {
      const ref = await this.#tryReference(target, src.id, latest);
      if (ref) return this.#decide(st, src.id, target, st.candidate, ref);
      return (st.update = { ...base, latest, status: 'pending', verification: 'unverified', pending: latest, reason: st.update.reason });
    }
    if (!manual && this.#failed.get(src.id) === latest) {
      const prev = (st.update.status === 'blocked' || st.update.status === 'failed') && st.update.latest === latest ? st.update : undefined;
      return (st.update = prev
        ? { ...prev, ...base }
        : { ...base, latest, status: 'failed', error: `${latest} did not install last time; press the update button to retry` });
    }
    await this.#dropCandidate(st);
    let file: string;
    let sha256: string;
    try {
      file = await this.#uniqueCopy(await src.download(latest, cacheDir));
      sha256 = await sha256File(file);
    } catch (e) {
      this.#failed.set(src.id, latest);
      return (st.update = { ...base, latest, status: 'failed', error: `download failed (${errMsg(e)})`.slice(0, 400) });
    }
    if (!src.verify) {
      return this.#install(st, src.id, target, { version: latest, file, sha256, files: {} }, src.verification ?? 'marketplace');
    }
    // 시험 폴더에 깔아 살펴봐요 — 깔리지도 않으면(엔진 비호환·깨진 파일·다른 ID) 실패예요, 사용자 확인 대상이 아니에요
    let inspected: { id?: string; version: string; files: TreeHashes };
    try {
      inspected = await this.#verifier(target).candidate(src.id, file);
    } catch (e) {
      await fsp.rm(file, { force: true }).catch(() => undefined);
      this.#failed.set(src.id, latest);
      return (st.update = { ...base, latest, status: 'failed', error: `the Open VSX build could not be inspected (${errMsg(e)})`.slice(0, 400) });
    }
    const candidate: Candidate = { version: latest, file, sha256, files: inspected.files };
    if (inspected.version !== latest || (inspected.id !== undefined && inspected.id.toLowerCase() !== src.id.toLowerCase())) {
      return this.#block(st, src.id, base, candidate, `the Open VSX file is ${inspected.id ?? src.id} ${inspected.version}, not ${src.id} ${latest}`);
    }
    const ref = await this.#tryReference(target, src.id, latest);
    if (ref) return this.#decide(st, src.id, target, candidate, ref);
    st.candidate = candidate;
    const reason = this.#lastReferenceError ?? 'no official build hashes to compare with';
    this.#opts.log?.warn(`agent extension ${src.id} ${latest}: not verified against the official build (${reason}); waiting for the user`);
    return (st.update = { ...base, latest, status: 'pending', verification: 'unverified', pending: latest, reason });
  }

  #lastReferenceError: string | undefined;

  /** 기준 해시 — 없으면 undefined(이유는 #lastReferenceError) */
  async #tryReference(target: AgentUpdateTarget, id: string, version: string): Promise<TreeHashes | undefined> {
    try {
      const r = await this.#verifier(target).reference(id, version);
      this.#lastReferenceError = undefined;
      return r;
    } catch (e) {
      this.#lastReferenceError = `no official build hashes to compare with (${errMsg(e)})`.slice(0, 300);
      return undefined;
    }
  }

  /** 기준과 대조해 같으면 깔고 다르면 막아요 */
  async #decide(st: ExtState, id: string, target: AgentUpdateTarget, c: Candidate, ref: TreeHashes): Promise<AgentExtensionUpdate> {
    const cmp = compareTrees(ref, c.files);
    const installed = await newestInstalledVersion(target.extensionsDir, id);
    const base = { id, installed, ...(st.update.installedVerification ? { installedVerification: st.update.installedVerification } : {}) };
    if (!cmp.same) {
      const sample = [...cmp.differ, ...cmp.missing, ...cmp.extra].slice(0, 3).join(', ');
      return this.#block(st, id, base, c, `${cmp.differ.length} differ, ${cmp.missing.length} missing, ${cmp.extra.length} extra files (${sample})`.slice(0, 300));
    }
    this.#opts.log?.info(`agent extension ${id} ${c.version}: gallery build matches the official build (${Object.keys(ref).length} files)`);
    return this.#install(st, id, target, c, 'verified');
  }

  async #block(st: ExtState, id: string, base: Partial<AgentExtensionUpdate>, c: Candidate, reason: string): Promise<AgentExtensionUpdate> {
    await fsp.rm(c.file, { force: true }).catch(() => undefined);
    if (st.candidate === c) st.candidate = undefined;
    this.#failed.set(id, c.version);
    this.#opts.log?.warn(`agent extension ${id} ${c.version}: gallery build differs from the official build — BLOCKED (${reason})`);
    return (st.update = { ...base, id, latest: c.version, status: 'blocked', verification: 'mismatch', reason });
  }

  /** 고정한 바이트 그대로인지 다시 확인하고 그 파일로 깔아요 */
  async #install(st: ExtState, id: string, target: AgentUpdateTarget, c: Candidate, verification: ExtensionVerification): Promise<AgentExtensionUpdate> {
    const r = await this.#opts.installer.updateExtension(target, id, c.version, async () => {
      if ((await sha256File(c.file)) !== c.sha256) throw new Error('the VSIX changed after it was checked');
      return c.file;
    });
    await fsp.rm(c.file, { force: true }).catch(() => undefined);
    if (st.candidate === c) st.candidate = undefined;
    if (r.status === 'failed') {
      this.#failed.set(id, c.version);
      this.#opts.log?.warn(`agent extension ${id} update to ${c.version} failed: ${r.error ?? '?'}`);
    } else {
      this.#failed.delete(id);
    }
    if (r.status === 'updated') st.checkedInstalled = r.installed;
    const installedVerification = r.status === 'updated' ? verification : st.update.installedVerification;
    return (st.update = {
      id,
      installed: r.installed,
      ...(installedVerification ? { installedVerification } : {}),
      latest: c.version,
      status: r.status,
      verification,
      ...(r.error ? { error: r.error.slice(0, 400) } : {}),
    });
  }

  #pendingFields(st: ExtState): Partial<AgentExtensionUpdate> {
    return st.candidate ? { latest: st.candidate.version, pending: st.candidate.version, verification: 'unverified', reason: st.update.reason } : {};
  }

  /** 깔린 버전도 한 번 대조해 둬요(Open VSX에서 받은 확장만, 버전마다 한 번 — 검증 못 했으면 수동 확인 때 다시) */
  async #installedVerification(
    src: AgentExtensionSource,
    target: AgentUpdateTarget,
    st: ExtState,
    installed: string | undefined,
    manual: boolean,
  ): Promise<ExtensionVerification | undefined> {
    if (!installed) return undefined;
    if (!src.verify) return src.verification ?? 'marketplace';
    if (st.checkedInstalled === installed && !(manual && st.update.installedVerification === 'unverified')) return st.update.installedVerification;
    const prefix = `${src.id}-${installed}`.toLowerCase();
    let folder: string | undefined;
    try {
      folder = (await fsp.readdir(target.extensionsDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .find((n) => n.toLowerCase() === prefix || n.toLowerCase().startsWith(`${prefix}-`));
    } catch {
      return undefined;
    }
    if (!folder) return undefined;
    const verifier = this.#verifier(target);
    let result: ExtensionVerification;
    try {
      const [reference, files] = await Promise.all([verifier.reference(src.id, installed), verifier.installed(join(target.extensionsDir, folder))]);
      result = compareTrees(reference, files).same ? 'verified' : 'mismatch';
      if (result === 'mismatch') this.#opts.log?.warn(`agent extension ${src.id} ${installed}: the INSTALLED copy differs from the official build`);
    } catch (e) {
      this.#opts.log?.info(`agent extension ${src.id} ${installed}: installed copy not verified (${errMsg(e)})`);
      result = 'unverified';
    }
    st.checkedInstalled = installed;
    st.update = { ...st.update, installedVerification: result };
    return result;
  }

  /** 받은 파일을 이 확인만의 이름으로 — 같은 버전을 다시 받아도 살펴본 파일을 덮지 않게 */
  async #uniqueCopy(file: string): Promise<string> {
    const unique = file.replace(/\.vsix$/i, '') + `-${process.pid}-${Date.now().toString(36)}-${++this.#seq}.vsix`;
    await fsp.rename(file, unique);
    return unique;
  }

  async #dropCandidate(st: ExtState): Promise<void> {
    if (st.candidate) await fsp.rm(st.candidate.file, { force: true }).catch(() => undefined);
    st.candidate = undefined;
  }

  /** 지난 실행(꺼짐·강제 종료)이 남긴 받은 VSIX·임시 파일·시험 폴더 — 확인 대기 상태는 메모리라 다시 받아요 */
  async #sweepLeftovers(): Promise<void> {
    const sweep = async (dir: string, match: (name: string) => boolean) => {
      let names: string[] = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        return;
      }
      for (const n of names.filter(match)) await fsp.rm(join(dir, n), { recursive: true, force: true }).catch(() => undefined);
    };
    await sweep(join(this.#opts.home, 'cache', 'vsix'), (n) => /\.(vsix|tmp)$/i.test(n));
    await sweep(join(this.#opts.home, 'verify'), (n) => n.startsWith('stage-'));
  }
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', resolve)
      .on('error', reject);
  });
  return h.digest('hex');
}
