// folders.clone: git 저장소를 새 폴더로 클론해요(통합 창 «폴더 등록» 칸에 주소). git은 PATH의 것을 써요.
import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';

/** 클론 한 번의 한도 — 큰 저장소도 끝나게 넉넉히, 멈춘 git(응답 없는 서버)은 끝내요 */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

export type GitCloneFn = (url: string, dest: string) => Promise<void>;

export class GitCloneError extends Error {
  readonly code: 'not_found' | 'failed' | 'timeout';
  constructor(message: string, code: 'not_found' | 'failed' | 'timeout') {
    super(message);
    this.name = 'GitCloneError';
    this.code = code;
  }
}

/** stderr를 이만큼만 들고 있어요(진행 표시가 길어도) */
const MAX_STDERR = 64 * 1024;

/** git이 실패 끝에 붙이는 일반 안내 줄 — 원인 줄을 가려서 빼요 */
const GENERIC_LINES = [/^Cloning into /i, /^Please make sure you have the correct access rights/i, /^and the repository exists\.?$/i, /^(remote|Receiving|Resolving|Updating|Counting|Compressing|Enumerating)\b/i];

/** 사람이 읽을 원인: git의 일반 안내·진행 줄을 빼고 첫 줄, 흔한 ssh 원인에는 한국어 안내 */
export function cloneFailureMessage(stderr: string): string {
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !GENERIC_LINES.some((re) => re.test(l)));
  const cause = lines[0];
  if (!cause) return 'git clone 실패';
  let hint = '';
  if (/Host key verification failed/i.test(stderr)) hint = ' — 이 서버에 처음 ssh로 붙어요. 터미널에서 한 번 직접 클론해(호스트 키 확인) 주세요.';
  else if (/Permission denied \(publickey/i.test(stderr)) hint = ' — ssh 키가 없거나 ssh-agent에 올라가 있지 않아요. https 주소를 쓰거나 키를 올려 주세요.';
  return `git clone 실패: ${cause}${hint}`;
}

/**
 * `git clone -- <url> <dest>`. 터미널 암호 묻기는 끄고(`GIT_TERMINAL_PROMPT=0` — 숨은 데몬에서 영원히 기다리지 않게), Git Credential
 * Manager 같은 창 도우미는 그대로 둬요(비공개 저장소 로그인). 제한 시간이 지나면 **프로세스 트리째** 끝내요 — `cmd\git.exe`는 진짜 git을
 * 띄우는 껍데기라 그것만 끝내면 클론이 계속돼요(2026-10-26 실측). 실패하면 dest 정리는 부르는 쪽 몫이에요.
 */
export function runGitClone(url: string, dest: string, opts: { timeoutMs?: number; git?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      opts.git ?? 'git',
      ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--', url, dest],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );
    let stderr = '';
    let timedOut = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => {
      stderr = (stderr + s).slice(-MAX_STDERR);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs ?? CLONE_TIMEOUT_MS);
    child.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new GitCloneError('git을 찾지 못했어요(PATH에 git이 없어요)', 'not_found') : new GitCloneError(`git을 실행하지 못했어요: ${e.message}`, 'failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new GitCloneError('git clone이 제한 시간 안에 끝나지 않았어요', 'timeout'));
      if (code === 0) return resolve();
      reject(new GitCloneError(cloneFailureMessage(stderr), 'failed'));
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 이미 끝남
    }
  }
}

/** 실패한 클론이 남긴 폴더 지우기(부르는 쪽이 클론 전에 없던 걸 확인한 dest만). 잠긴 파일은 잠깐 기다려 다시 */
export async function removePartialClone(dest: string): Promise<void> {
  await fsp.rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }).catch(() => {});
}
