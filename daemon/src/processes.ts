// 실행 파일 경로로 프로세스 찾기 — Windows Get-CimInstance Win32_Process(PowerShell). 설치·제거(setup/main.ts — 사용 중인 프로그램)와
// «다시 시작해서 적용»(교훈 012 — 옛 판 main이 파이프만 놓은 게 아니라 정말 끝났는지)이 같이 써요. 시험은 PowerShell을 띄우지 않게 바꿔 끼워요.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export interface ProgramProcess {
  ProcessId: number;
  Name: string;
  /** 관리자 권한 프로세스는 일반 권한 조회에서 경로가 비어요(null) */
  ExecutablePath: string | null;
}

/** 폴더 → 경로 앞부분 비교용(끝에 `\` 하나 — `Mk42-1.143.1`이 `Mk42-1.143.10`에 걸리지 않게) */
export function dirPrefix(dir: string): string {
  return `${resolve(dir).replace(/[\\/]+$/, '')}\\`;
}

function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * 실행 파일이 prefix(폴더, 끝에 `\`) 아래인 프로세스. pathlessNames: 경로를 못 읽는(관리자 권한으로 뜬) 프로세스 중 이 이름(대소문자 무시)도 넣어요.
 * 경로·이름은 환경 변수로 넘겨요(따옴표·주입 걱정 없게). Windows 밖은 빈 목록. 목록을 못 읽으면 throw.
 */
export async function processesUnder(prefix: string, pathlessNames: readonly string[] = []): Promise<ProgramProcess[]> {
  if (process.platform !== 'win32') return [];
  const r = await runPowerShell(
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=$env:MK42_PREFIX; $n=@($env:MK42_PATHLESS -split [char]124 | Where-Object { $_ }); ' +
      'Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)) -or ' +
      '((-not $_.ExecutablePath) -and ($n -contains $_.Name)) } | ' +
      'Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
    { ...process.env, MK42_PREFIX: prefix, MK42_PATHLESS: pathlessNames.join('|') },
  );
  if (r.code !== 0) throw new Error(`process list failed: ${r.stderr.trim()}`);
  const raw = r.stdout.trim();
  return (raw ? [JSON.parse(raw)].flat() : []) as ProgramProcess[];
}

/** 그 폴더 안 실행 파일로 도는 프로세스 pid — 시험에서 바꿔 끼워요. 목록을 못 읽으면 throw */
export type ProcessIdLister = (dir: string) => Promise<number[]>;

export const defaultProcessIdLister: ProcessIdLister = async (dir) => (await processesUnder(dirPrefix(dir))).map((p) => p.ProcessId);
