// hub (B) 창 — Mk42 통합 창 exe(D46, WinForms + WebView2), 없으면 Edge `--app=` 창(D20-B). 실행기는 주입해요(테스트에서 띄우지 않음).
import { existsSync, promises as fsp } from 'node:fs';
import { join, win32 } from 'node:path';
import { defaultSpawn, sanitizeLaunchEnv, type SpawnFn, type SpawnResult } from './launcher.ts';

export function edgeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const x86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'];
  if (x86) out.push(win32.join(x86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  const pf = env.ProgramFiles ?? env.PROGRAMFILES;
  if (pf) out.push(win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (out.length === 0) out.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  return out;
}

/**
 * 허브 전용 프로필은 사용자 Edge 계정과 무관해야 해요. 그냥 띄우면 Edge가 Windows 계정으로 저절로 로그인(implicit sign-in)하고
 * 동기화로 확장을 깔아, 확장의 첫 실행 창이 따로 떠요(2026-10-21 실측). 그래서 implicit sign-in·동기화·확장을 꺼요
 * (실측: msImplicitSignin을 꺼야 로그인 안 함, --disable-extensions라야 확장 폴더가 안 생김).
 */
export function buildEdgeArgs(url: string, userDataDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msImplicitSignin',
    '--disable-sync',
    '--disable-extensions',
  ];
}

export function hubEdgeUserDataDir(home: string): string {
  return join(home, 'hub-edge');
}

/**
 * D46 Mk42 통합 창(`hub-host/`, WinForms + WebView2) — `<home>\hub\mk42-hub.exe`. home은 본인 전용 폴더라 남이 바꿔치기할 수
 * 없어요. 설치: `dotnet publish hub-host\src\Mark42.Hub -p:PublishProfile=win-x64 -o "%LOCALAPPDATA%\Mark42\hub"`.
 */
export function hubHostExe(home: string): string {
  return join(home, 'hub', 'mk42-hub.exe');
}

/**
 * Mk42 통합 창이 떠 있나: 창이 떠 있는 동안 쓰는 `<home>\hub-host.json`의 pid가 살아 있으면 true. 데몬이 다시 뜰 때 이걸 보고 통합 창을
 * 다시 열어(새 토큰 주소를 넘김) 창이 이어지게 해요 — 안 그러면 그 창은 지난 토큰으로 붙으려다 거절돼 닫혀요.
 */
export async function hubHostRunning(home: string, isAlive: (pid: number) => boolean = pidAlive): Promise<boolean> {
  try {
    const pid = (JSON.parse(await fsp.readFile(join(home, 'hub-host.json'), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && isAlive(pid);
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface OpenHubWindowOptions {
  url: string;
  home: string;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  /** 직접 지정 (없으면 후보 중 있는 것) */
  edgePath?: string;
  /** settings.hubWindow: 'auto'(기본) = Mk42 통합 창 exe가 있으면 그것, 없으면 Edge. 'edge' = 늘 Edge */
  hubWindow?: 'auto' | 'edge';
  /** settings.hubHostPath: Mk42 통합 창 exe 직접 지정 (없으면 {@link hubHostExe}) */
  hubHostPath?: string;
}

export async function openHubWindow(
  opts: OpenHubWindowOptions,
): Promise<SpawnResult & { exe: string; args: string[]; kind: 'host' | 'edge' }> {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  if (opts.hubWindow !== 'edge') {
    // Mk42 통합 창은 home마다 하나만 떠요 — 이미 떠 있으면 새 주소를 넘겨받고 앞으로 나와요(HubInstance)
    const host = opts.hubHostPath ?? hubHostExe(opts.home);
    if (exists(host)) {
      const args = ['--url', opts.url, '--home', opts.home];
      const r = await (opts.spawn ?? defaultSpawn)(host, args, sanitizeLaunchEnv(env));
      return { ...r, exe: host, args, kind: 'host' };
    }
  }
  const exe = opts.edgePath ?? edgeCandidates(env).find((p) => exists(p));
  if (!exe) throw new Error('msedge.exe not found');
  const args = buildEdgeArgs(opts.url, hubEdgeUserDataDir(opts.home));
  const r = await (opts.spawn ?? defaultSpawn)(exe, args, sanitizeLaunchEnv(env));
  return { ...r, exe, args, kind: 'edge' };
}
