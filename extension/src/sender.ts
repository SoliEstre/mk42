// 전송기(D11): osKeys = 패널 포커스 뒤 PowerShell SendKeys로 Enter, none = 채우기만.
import { execFile, spawn } from 'node:child_process';
import {
  ABORTED_EXIT,
  FOREGROUND_MISMATCH_EXIT,
  escapeSendKeys,
  parseReadyLine,
  powershellArgs,
  sendKeysHandshakeScript,
  type CommandResult,
  type CommandRunner,
  type InteractiveProcess,
  type InteractiveSpawner,
} from './lib/sendkeys.ts';
import type { Logger } from './log.ts';

export const defaultRunner: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

export const defaultSpawner: InteractiveSpawner = (file, args, timeoutMs) => {
  const child = spawn(file, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const listeners: ((l: string) => void)[] = [];
  let stdout = '';
  let stderr = '';
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    stdout += d;
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      for (const cb of listeners) cb(line);
    }
  });
  child.stderr.on('data', (d: string) => {
    stderr += d;
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const done = new Promise<CommandResult>((resolve) => {
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  const proc: InteractiveProcess = {
    onLine: (cb) => void listeners.push(cb),
    write: (line) => {
      if (!child.stdin.destroyed) child.stdin.end(`${line}\n`);
    },
    done,
    kill: () => void child.kill(),
  };
  return proc;
};

export interface SendResult {
  ok: boolean;
  detail: string;
}

export interface OsKeySenderOptions {
  spawner?: InteractiveSpawner;
  /** VS Code 창(HWND)의 주인 = 메인 프로세스 = 확장 호스트의 부모(실측). 다른 앱으로 가는 것만 막아요 */
  expectedPid?: number;
  /** 이 창이 지금 포커스인지 (vscode.window.state.focused) */
  isFocused?: () => boolean;
  platform?: NodeJS.Platform;
  /** 확인 사이 짧은 대기 */
  sleep?: (ms: number) => Promise<void>;
  /** 준비(READY) 대기 한도 */
  readyTimeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OsKeySender {
  #spawner: InteractiveSpawner;
  #log: Logger;
  #expectedPid: number | undefined;
  #isFocused: () => boolean;
  #platform: NodeJS.Platform;
  #sleep: (ms: number) => Promise<void>;
  #readyTimeoutMs: number;
  /** 포커스가 확인된 순간의 전경 HWND = 이 창 (한 번 알면 그 창에만 보내요) */
  #ownHwnd: number | undefined;

  constructor(log: Logger, opts: OsKeySenderOptions = {}) {
    this.#log = log;
    this.#spawner = opts.spawner ?? defaultSpawner;
    this.#platform = opts.platform ?? process.platform;
    this.#expectedPid = this.#platform === 'win32' ? (opts.expectedPid ?? process.ppid) : undefined;
    this.#isFocused = opts.isFocused ?? (() => true);
    this.#sleep = opts.sleep ?? realSleep;
    this.#readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  }

  get available(): boolean {
    return this.#platform === 'win32';
  }

  /** 배운 이 창 HWND (진단용) */
  get ownHwnd(): number | undefined {
    return this.#ownHwnd;
  }

  async keys(keys: string): Promise<SendResult> {
    if (!this.available) return { ok: false, detail: 'osKeys sender is Windows-only' };
    const proc = this.#spawner('powershell.exe', powershellArgs(sendKeysHandshakeScript(keys, this.#expectedPid)), 20_000);
    const ready = await new Promise<string | undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), this.#readyTimeoutMs);
      proc.onLine((line) => {
        if (!line.startsWith('M42READY')) return;
        clearTimeout(t);
        resolve(line);
      });
      void proc.done.then(() => {
        clearTimeout(t);
        resolve(undefined);
      });
    });
    const abort = async (detail: string): Promise<SendResult> => {
      proc.write('ABORT');
      await Promise.race([proc.done, this.#sleep(3_000)]);
      proc.kill();
      this.#log.warn(`osKeys not sent: ${detail}`);
      return { ok: false, detail };
    };
    const fg = ready ? parseReadyLine(ready) : undefined;
    if (!fg) {
      proc.kill();
      const r = await proc.done;
      const detail = `powershell not ready (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`;
      this.#log.warn(`osKeys failed: ${detail}`);
      return { ok: false, detail };
    }
    if (this.#expectedPid !== undefined && fg.pid !== this.#expectedPid) return abort(`foreground window is not this app (pid ${fg.pid})`);
    if (!this.#isFocused()) return abort('window lost focus');
    if (this.#ownHwnd !== undefined && fg.hwnd !== this.#ownHwnd) {
      // 다른 VS Code 창이 앞에 있어요. 혹시 잘못 배웠을 수 있으니 다음 번에 다시 배워요
      this.#ownHwnd = undefined;
      return abort(`foreground is another window (hwnd ${fg.hwnd})`);
    }
    // 포커스 이벤트가 늦게 올 수 있어서 잠깐 뒤에 한 번 더 확인해요
    await this.#sleep(120);
    if (!this.#isFocused()) return abort('window lost focus');
    this.#ownHwnd = fg.hwnd;
    proc.write(`GO ${fg.hwnd}`);
    const r = await proc.done;
    if (r.code === 0) {
      if (!this.#isFocused()) return { ok: false, detail: 'sent, but focus changed during send' };
      return { ok: true, detail: 'sent' };
    }
    const detail =
      r.code === FOREGROUND_MISMATCH_EXIT
        ? `foreground changed before send (${r.stdout.replace(/^M42READY.*\r?\n/, '').trim()})`
        : r.code === ABORTED_EXIT
          ? 'aborted'
          : `powershell exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`;
    this.#log.warn(`osKeys failed: ${detail}`);
    return { ok: false, detail };
  }

  enter(): Promise<SendResult> {
    return this.keys('{ENTER}');
  }

  /** 클립보드 붙여 넣기(+선택적 Enter) — Codex처럼 채우는 공식 경로가 없을 때 */
  paste(withEnter: boolean): Promise<SendResult> {
    return this.keys(withEnter ? '^v{ENTER}' : '^v');
  }

  typeLiteral(text: string): Promise<SendResult> {
    return this.keys(escapeSendKeys(text));
  }
}
