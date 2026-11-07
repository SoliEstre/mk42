// ~/.claude/sessions/<pid>.json 관찰(읽기 전용) — 새 세션 창의 세션 ID 알아내기. *.key(자격 증명)는 열지 않아요.
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigDir } from '@mark42/protocol/paths';
import {
  bindingCandidates,
  isSessionRegistryFile,
  parseClaudeSessionFile,
  resolveByParent,
  resolveWithoutParents,
  type BindingResult,
  type ClaudeSessionEntry,
} from './lib/claudeBinding.ts';
import { powershellArgs, type CommandRunner } from './lib/sendkeys.ts';
import type { Logger } from './log.ts';

export function claudeSessionsDir(): string {
  return join(claudeConfigDir(), 'sessions');
}

export async function readClaudeSessions(dir = claudeSessionsDir()): Promise<ClaudeSessionEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ClaudeSessionEntry[] = [];
  for (const name of names) {
    if (!isSessionRegistryFile(name)) continue;
    try {
      const e = parseClaudeSessionFile(await readFile(join(dir, name), 'utf8'));
      if (e) out.push(e);
    } catch {
      // 쓰는 중이거나 지워진 파일
    }
  }
  return out;
}

/** 한 번의 CIM 조회로 이 프로세스의 자식 pid 목록(Windows). 느려서(수 초) 새 후보가 생겼을 때만 불러요. */
export async function childPids(
  runner: CommandRunner,
  parentPid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<Set<number> | undefined> {
  if (platform !== 'win32') return undefined;
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Math.floor(parentPid)}" | ForEach-Object { $_.ProcessId }`;
  const r = await runner('powershell.exe', powershellArgs(script), 60_000);
  if (r.code !== 0) return undefined;
  return new Set(
    r.stdout
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

export interface WaitBindingOptions {
  folderPath: string;
  openedAt: number;
  excludeSessionIds: ReadonlySet<string>;
  timeoutMs: number;
  hostPid?: number;
  pollMs?: number;
}

export class ClaudeSessionBinder {
  #log: Logger;
  #runner: CommandRunner;
  #dir: string;
  #platform: NodeJS.Platform;
  #disposers = new Set<() => void>();
  constructor(log: Logger, runner: CommandRunner, dir = claudeSessionsDir(), platform: NodeJS.Platform = process.platform) {
    this.#log = log;
    this.#runner = runner;
    this.#dir = dir;
    this.#platform = platform;
  }

  async snapshotIds(): Promise<Set<string>> {
    return new Set((await readClaudeSessions(this.#dir)).map((e) => e.sessionId));
  }

  /**
   * 새 세션이 sessions/에 나타날 때까지 기다려요. CLI는 첫 메시지 때 뜰 수 있어서(채우기만 한 경우) 넉넉히 기다려요.
   * 결과 없음 = undefined.
   */
  waitForNewSession(o: WaitBindingOptions): Promise<string | undefined> {
    const hostPid = o.hostPid ?? process.pid;
    return new Promise((resolve) => {
      let done = false;
      let busy = false;
      let again = false;
      let warned = false;
      const rejected = new Set<string>();
      let watcher: FSWatcher | undefined;
      const finish = (id: string | undefined) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        clearTimeout(deadline);
        watcher?.close();
        this.#disposers.delete(cancel);
        resolve(id);
      };
      const cancel = () => finish(undefined);
      const check = async () => {
        if (done) return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          const entries = await readClaudeSessions(this.#dir);
          const cands = bindingCandidates(entries, {
            folderPath: o.folderPath,
            openedAt: o.openedAt,
            excludeSessionIds: o.excludeSessionIds,
          }).filter((c) => !rejected.has(c.sessionId));
          if (cands.length > 0) {
            // 후보가 하나여도 부모 pid로 확인해요(같은 폴더의 다른 창 세션일 수 있어요)
            const kids = await childPids(this.#runner, hostPid, this.#platform);
            let r: BindingResult;
            if (kids) {
              const parents = new Map<number, number | undefined>(cands.map((c) => [c.pid, kids.has(c.pid) ? hostPid : undefined]));
              r = resolveByParent(cands, parents, hostPid);
              // 이 확장 호스트의 자식이 아닌 후보는 다른 창 것 — 다시 조회하지 않아요
              if (r.status !== 'bound') for (const c of cands) rejected.add(c.sessionId);
            } else {
              r = resolveWithoutParents(cands, o.openedAt);
              if (r.status !== 'bound' && !warned) {
                warned = true;
                this.#log.warn(`claude session candidates (${cands.length}) not bound: parent pid lookup unavailable`);
              }
            }
            if (r.status === 'bound') {
              this.#log.info(`claude session bound (${r.via}): ${r.sessionId}`);
              finish(r.sessionId);
            }
          }
        } catch (e) {
          this.#log.error('claude session scan failed', e);
        } finally {
          busy = false;
          if (again && !done) {
            again = false;
            void check();
          }
        }
      };
      const timer = setInterval(() => void check(), o.pollMs ?? 2_000);
      const deadline = setTimeout(() => finish(undefined), o.timeoutMs);
      try {
        watcher = watch(this.#dir, { persistent: false }, (_ev, name) => {
          if (typeof name === 'string' && !isSessionRegistryFile(name)) return;
          void check();
        });
        watcher.on('error', () => watcher?.close());
      } catch {
        // 폴더가 아직 없으면 폴링만
      }
      this.#disposers.add(cancel);
      void check();
    });
  }

  dispose(): void {
    for (const d of [...this.#disposers]) d();
  }
}
