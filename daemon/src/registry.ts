// <home>/registry.json — 폴더·고정 세션·슬롯·설정. 원자적 쓰기(tmp → rename), 쓰기 직렬화, 손상 파일 복구.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { AgentKind, Folder, PinnedSession, ResumeMode } from '@mark42/protocol';
import { errCode, renameWithRetry, timestampForFile } from './fsutil.ts';
import { errMsg, type Logger } from './log.ts';

export const REGISTRY_SCHEMA_VERSION = 1;
export const REGISTRY_FILE = 'registry.json';

/** 설치본 직접 지정 (R10 버전별 폴더) */
/** 어느 앱인지: 공식 VS Code(Code.exe) 또는 Mark42 패치 빌드(Mk42.exe, D47). 같은 버전 번호여도 다른 앱이에요 */
export type AppProduct = 'vscode' | 'mark42';

export interface AppInstall {
  version: string;
  exe: string;
  /** 없으면 'vscode' */
  product?: AppProduct;
  commit?: string;
  userDataDir?: string;
  extensionsDir?: string;
  /** `--shared-data-dir` (Daemon/005). 없으면 `<userDataDir>-shared` — userDataDir가 있을 때만 써요 */
  sharedDataDir?: string;
}

/** agent 창 세션 슬롯 (D18 한 창 한 세션) */
export interface SlotRecord {
  slotId: string;
  folderPath: string;
  agent: AgentKind;
  sessionId?: string;
  createdAt: string;
}

export interface DaemonSettings {
  /** 부팅 재개 모드. 없으면 판 기본값(edition.ts — 공개판 console) */
  resumeMode?: ResumeMode;
  /** 창을 띄울 앱. 없으면 판 기본값(edition.ts — 공개판 'mark42') */
  defaultAppProduct?: AppProduct;
  apps: AppInstall[];
  /**
   * Mark42가 맡은 확장 폴더에 첫 실행 때 한국어 언어팩·Claude Code·Codex 확장을 깔기. 기본 true.
   * 기본 프로필에만 깔아요 — 역할 프로필(useRoleProfiles)은 따로 깔지 않아요.
   */
  installExtensions?: boolean;
  /**
   * Mark42 전용 user-data로 띄우는 창을 평소 VS Code와 떼어 놓기. 기본 true. user-data를 지정하지 않은 창(사용자 기본
   * 프로필)에는 아무것도 하지 않아요.
   * - `--shared-data-dir`: 공유 저장소(`~/.vscode-shared` — Windows에서는 GitHub 로그인 비밀·신뢰 폴더도 여기)를 따로. 덧층이 정한 폴더면
   *   `<home>\data\vscode-shared`, settings.apps[].userDataDir면 `<userDataDir>-shared`(또는 apps[].sharedDataDir).
   * - `--agent-plugins-dir`: 에이전트 플러그인(`~/.vscode/agent-plugins` — user-data와 상관없이 홈에 있어요)을 따로.
   *   `<home>\data\agent-plugins` 또는 `<userDataDir>-agent-plugins`.
   * - `--disable-updates`·`--skip-add-to-recently-opened`(최근 항목·점프 목록 흔적 줄이기 — 점프 목록 덮어쓰기는 못 막아요).
   * - 그 user-data 설정 `update.mode`·`window.restoreWindows`·`window.titleBarStyle`(userData.ts MANAGED_USER_SETTINGS).
   */
  separateFromUserVsCode?: boolean;
  /** 역할 프로필(--profile) 사용. 새 프로필은 확장이 비어 있어서 PoC 기본 false */
  useRoleProfiles?: boolean;
  /** agent 창에서 다른 에이전트 확장을 --disable-extension으로 끄기(임시방편, 창 복원 때 사라짐). 기본 true */
  disableOtherAgentExtension?: boolean;
  /**
   * agent 창에서 쓰지 않는 기본 확장(git·github·npm·merge-conflict·emmet, JSON·TS·markdown·html·css 언어 기능)도 끄기(D47 경량화, launcher AGENT_WINDOW_TRIMMED_BUILTINS).
   * 기본 false — Mk42 패치 빌드로 옮길 때 연기 시험(에이전트가 vscode.git을 안 쓰는지) 뒤에 켜요.
   */
  trimAgentWindowBuiltins?: boolean;
  /** hub (B) UI 파일 위치 덮어쓰기 (index.html·hub-ui.js·hub-ui.css가 한 폴더에) */
  hubUiDir?: string;
  /** 통합 창 (B): 'auto'(기본) = Mk42 통합 창 exe(`<home>\hub\mk42-hub.exe`, D46)가 있으면 그것, 없으면 Edge 창. 'edge' = 늘 Edge */
  hubWindow?: 'auto' | 'edge';
  /** Mk42 통합 창 exe 직접 지정(기본 `<home>\hub\mk42-hub.exe`) */
  hubHostPath?: string;
  /** 재개 때 창 사이 간격(ms). 기본 1000 */
  resumeLaunchGapMs?: number;
  /** 재개 때 자동 전송 창의 결과 보고(window.reportResult)를 기다리는 시간(ms). 기본 120000 — 그동안 다음 창을 띄우지 않아요 */
  resumeResultTimeoutMs?: number;
  /**
   * PoC: 패키징 전이라 새로 띄우는 창에 `--extensionDevelopmentPath`로 Mark42 확장을 실어요.
   * VS Code 메인은 개발 경로가 같은 창이 있으면 새 창 대신 그 창을 다시 로드해요(1.141.1·1.142.0 mainImpl.js 확인).
   * 그래서 창(워크스페이스 파일)마다 <home>\devext\<해시> 정션을 만들어 서로 다른 경로로 넘겨요.
   * 포커스용 재실행에는 붙이지 않아요.
   */
  extensionDevelopmentPath?: string;
  /**
   * Mark42 확장 .vsix(`mark42-<x.y.z>.vsix` 파일, 또는 그런 파일이 든 폴더 — 가장 높은 버전, 보통 `mark42\extension\out`).
   * 있으면 창을 띄우기 전에 그 버전을 확장 폴더에 깔고(`--force`) 그 창에는 extensionDevelopmentPath를 붙이지 않아요.
   * 확장 폴더가 정해진 경우만(isolateUserData 또는 settings.apps[].extensionsDir) — 사용자 기본 확장 폴더에는 깔지 않아요.
   */
  extensionVsix?: string;
  /**
   * Codex 인덱서 방식. 기본 'sqlite'(state_5.sqlite 읽기 전용).
   * 'auto'·'appServer'는 사용자 ~/.codex로 `codex app-server`를 띄워요 — 그 프로세스는 DB를 읽기-쓰기로 열고
   * 마이그레이션할 수 있어서 «~/.codex 읽기 전용» 규칙의 예외예요. 쓰지 않는다는 실측 전에는 켜지 마세요.
   */
  codexIndexer?: 'sqlite' | 'auto' | 'appServer';
  /**
   * Mk42 자체 업데이트(updater.ts, 계약 C4). 채널·주소·서명 공개 키는 설치 기록(install.json update)에서 와요 — 여기는 동작만.
   * autoInstall: 새 판을 받아 확인하면 묻지 않고 바로 조용한 설치를 띄워요. 기본 false(창이 «지금 설치할까요?»를 물어요).
   */
  update?: { autoInstall?: boolean };
}

export interface RegistryData {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  folders: Folder[];
  pinned: PinnedSession[];
  slots: SlotRecord[];
  settings: DaemonSettings;
}

export function emptyRegistry(): RegistryData {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    folders: [],
    pinned: [],
    slots: [],
    settings: { apps: [] },
  };
}

/** 알 수 없는 키는 보존하고, 빠진 키는 기본값으로 채워요. 형태가 틀리면 throw. */
function coerce(raw: unknown): RegistryData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('registry root is not an object');
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== undefined && r.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${String(r.schemaVersion)}`);
  }
  const arr = (k: string): unknown[] => {
    const v = r[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${k} is not an array`);
    return v.filter((x) => typeof x === 'object' && x !== null);
  };
  const settingsRaw = r.settings ?? {};
  if (typeof settingsRaw !== 'object' || settingsRaw === null || Array.isArray(settingsRaw)) {
    throw new Error('settings is not an object');
  }
  const s = settingsRaw as Record<string, unknown>;
  const settings: DaemonSettings = {
    ...(s as Partial<DaemonSettings>),
    // 저장된 값이 맞으면 그대로, 없거나 틀리면 비워 둬요(판 기본값을 파일에 굳히지 않게)
    resumeMode: s.resumeMode === 'console' || s.resumeMode === 'firstRemoteApp' ? s.resumeMode : undefined,
    apps: Array.isArray(s.apps)
      ? (s.apps as AppInstall[]).filter((a) => a && typeof a.exe === 'string' && typeof a.version === 'string')
      : [],
  };
  return {
    ...(r as object),
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    folders: arr('folders') as Folder[],
    pinned: arr('pinned') as PinnedSession[],
    slots: arr('slots') as SlotRecord[],
    settings,
  } as RegistryData;
}

export interface RegistryFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  mkdir(p: string): Promise<void>;
}

const nodeFs: RegistryFs = {
  readFile: (p) => fsp.readFile(p, 'utf8'),
  writeFile: async (p, d) => {
    const h = await fsp.open(p, 'w');
    try {
      await h.writeFile(d, 'utf8');
      await h.sync();
    } finally {
      await h.close();
    }
  },
  rename: (a, b) => fsp.rename(a, b),
  copyFile: (a, b) => fsp.copyFile(a, b),
  unlink: (p) => fsp.unlink(p),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true });
  },
};

export interface RegistryOptions {
  log?: Logger;
  fs?: Partial<RegistryFs>;
  /** rename 재시도 (Windows EPERM/EBUSY — 백신·인덱서가 잠깐 잡는 경우) */
  renameRetries?: number;
  renameRetryDelayMs?: number;
  now?: () => Date;
}

export class Registry {
  readonly file: string;
  #data: RegistryData;
  #fs: RegistryFs;
  #log: Logger | undefined;
  #retries: number;
  #retryDelay: number;
  #chain: Promise<void> = Promise.resolve();
  #dirty = false;
  #seq = 0;
  #listeners: ((d: RegistryData) => void)[] = [];

  private constructor(file: string, data: RegistryData, opts: RegistryOptions) {
    this.file = file;
    this.#data = data;
    this.#fs = { ...nodeFs, ...opts.fs };
    this.#log = opts.log;
    this.#retries = opts.renameRetries ?? 8;
    this.#retryDelay = opts.renameRetryDelayMs ?? 50;
  }

  static async load(home: string, opts: RegistryOptions = {}): Promise<Registry> {
    const fs = { ...nodeFs, ...opts.fs };
    const file = join(home, REGISTRY_FILE);
    await fs.mkdir(home);
    let data: RegistryData;
    let text: string | undefined;
    try {
      text = await fs.readFile(file);
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
    if (text === undefined || text.trim() === '') {
      data = emptyRegistry();
    } else {
      try {
        data = coerce(JSON.parse(text.replace(/^﻿/, '')));
      } catch (e) {
        const backup = `${file}.corrupt-${timestampForFile(opts.now?.() ?? new Date())}`;
        opts.log?.warn(`registry unreadable (${errMsg(e)}); backing up to ${backup} and starting empty`);
        try {
          await fs.rename(file, backup);
        } catch (e2) {
          // rename이 막혀도 원본은 복사로 남겨요(다음 쓰기가 덮어써요)
          opts.log?.warn(`registry backup rename failed (${errMsg(e2)}); copying instead`);
          await fs.copyFile(file, backup).catch((e3) => opts.log?.error(`registry backup copy failed: ${errMsg(e3)}`));
        }
        data = emptyRegistry();
      }
    }
    return new Registry(file, data, opts);
  }

  /** 읽기 전용으로 다뤄 주세요. 바꿀 때는 update(). */
  get data(): Readonly<RegistryData> {
    return this.#data;
  }

  get settings(): DaemonSettings {
    return this.#data.settings;
  }

  onChange(cb: (d: RegistryData) => void): void {
    this.#listeners.push(cb);
  }

  /** 메모리에서 바꾸고 쓰기를 예약해요. 쓰기는 직렬화되고, 몰리면 마지막 상태 한 번만 써요. */
  async update<T>(mutate: (d: RegistryData) => T): Promise<T> {
    const result = mutate(this.#data);
    this.#dirty = true;
    for (const cb of this.#listeners) {
      try {
        cb(this.#data);
      } catch {
        // 리스너 오류는 저장을 막지 않아요
      }
    }
    await this.#scheduleWrite();
    return result;
  }

  /** 남은 쓰기를 기다려요 (종료 때). */
  flush(): Promise<void> {
    return this.#chain;
  }

  #scheduleWrite(): Promise<void> {
    const next = this.#chain.then(async () => {
      if (!this.#dirty) return;
      this.#dirty = false;
      await this.#writeNow(JSON.stringify(this.#data, null, 2) + '\n');
    });
    this.#chain = next.catch((e) => {
      this.#dirty = true;
      this.#log?.error(`registry write failed: ${errMsg(e)}`);
    });
    return next;
  }

  async #writeNow(text: string): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}-${++this.#seq}`;
    await this.#fs.writeFile(tmp, text);
    try {
      await renameWithRetry(tmp, this.file, {
        retries: this.#retries,
        delayMs: this.#retryDelay,
        rename: (a, b) => this.#fs.rename(a, b),
      });
    } catch (e) {
      await this.#fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }
}
