// OS 키 입력(D11 «osKeys» 전송) — PowerShell + System.Windows.Forms.SendKeys.
//
// 전경 창 확인은 «이 창»까지 봐야 해요. 같은 Code.exe의 창은 메인 프로세스 하나를 같이 써서 pid만으로는
// 다른 Mark42 창·사용자 창과 구별이 안 돼요. 그래서 두 단계로 해요.
//   1) 스크립트가 준비(Add-Type 컴파일)를 마치면 그 순간의 전경 HWND·pid를 알려요(M42READY).
//   2) 확장이 «지금도 이 창이 포커스인지»(vscode.window.state.focused)와 이 창의 HWND를 확인하고 GO <hwnd>를 보내요.
//   3) 스크립트는 전경 HWND가 그대로인지 다시 보고 바로 SendWait — 확인과 키 입력 사이가 수 ms예요.
// 맞지 않으면 보내지 않아요(exit 3). 확장이 ABORT를 보내면 exit 4.

export const FOREGROUND_MISMATCH_EXIT = 3;
export const ABORTED_EXIT = 4;
export const READY_PREFIX = 'M42READY ';

/** SendKeys 특수 문자를 글자 그대로 보내게 감싸요. */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '+{ENTER}');
}

function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 확인 없이 바로 보내는 스크립트 (전경 확인 없음 — 테스트·진단용) */
export function sendKeysScript(keys: string, expectedForegroundPid?: number): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
  ];
  if (expectedForegroundPid !== undefined) {
    if (!Number.isInteger(expectedForegroundPid) || expectedForegroundPid <= 0) throw new Error('invalid pid');
    lines.push(
      FG_TYPE,
      '$fgPid = [uint32]0',
      '[void][M42.Fg]::GetWindowThreadProcessId([M42.Fg]::GetForegroundWindow(), [ref]$fgPid)',
      `if ($fgPid -ne ${expectedForegroundPid}) { [Console]::Out.Write("foreground=$fgPid"); exit ${FOREGROUND_MISMATCH_EXIT} }`,
    );
  }
  lines.push(`[System.Windows.Forms.SendKeys]::SendWait(${psSingleQuote(keys)})`);
  return lines.join('\n');
}

const FG_TYPE =
  "Add-Type -Namespace M42 -Name Fg -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'";

/**
 * 준비 → 확인 → 전송 스크립트. stdout 첫 줄 `M42READY <hwnd> <pid>`, stdin으로 `GO <hwnd>` 또는 `ABORT`.
 * GO를 받으면 전경 HWND가 <hwnd>이고 (expectedPid가 있으면) 그 창의 pid가 expectedPid일 때만 보내요.
 */
export function sendKeysHandshakeScript(keys: string, expectedForegroundPid?: number): string {
  if (expectedForegroundPid !== undefined && (!Number.isInteger(expectedForegroundPid) || expectedForegroundPid <= 0)) {
    throw new Error('invalid pid');
  }
  const pidCheck = expectedForegroundPid !== undefined ? ` -or $p -ne ${expectedForegroundPid}` : '';
  return [
    "$ErrorActionPreference = 'Stop'",
    // Add-Type 진행 표시가 stderr에 CLIXML로 섞이지 않게
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Windows.Forms',
    FG_TYPE,
    'function Get-M42Fg { $h = [M42.Fg]::GetForegroundWindow(); $q = [uint32]0; [void][M42.Fg]::GetWindowThreadProcessId($h, [ref]$q); return @($h.ToInt64(), $q) }',
    '$f = Get-M42Fg',
    `[Console]::Out.WriteLine('${READY_PREFIX}' + $f[0] + ' ' + $f[1])`,
    '[Console]::Out.Flush()',
    '$line = [Console]::In.ReadLine()',
    `if ($line -notmatch '^GO (\\d+)$') { exit ${ABORTED_EXIT} }`,
    '$want = [int64]$Matches[1]',
    '$f = Get-M42Fg',
    '$h = $f[0]; $p = $f[1]',
    `if ($h -ne $want${pidCheck}) { [Console]::Out.Write('foreground=' + $h + ':' + $p); exit ${FOREGROUND_MISMATCH_EXIT} }`,
    `[System.Windows.Forms.SendKeys]::SendWait(${psSingleQuote(keys)})`,
    'exit 0',
  ].join('\n');
}

export interface ReadyLine {
  hwnd: number;
  pid: number;
}

export function parseReadyLine(line: string): ReadyLine | undefined {
  const m = /^M42READY (-?\d+) (\d+)\s*$/.exec(line.trim());
  if (!m) return undefined;
  const hwnd = Number(m[1]);
  const pid = Number(m[2]);
  return Number.isSafeInteger(hwnd) && Number.isSafeInteger(pid) ? { hwnd, pid } : undefined;
}

/** -EncodedCommand(UTF-16LE base64)라 따옴표·한글이 깨지지 않아요. */
export function powershellArgs(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 테스트에서 주입할 수 있는 명령 실행기 */
export type CommandRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

/** stdin/stdout으로 주고받는 프로세스 (핸드셰이크 전송용) */
export interface InteractiveProcess {
  onLine(cb: (line: string) => void): void;
  write(line: string): void;
  readonly done: Promise<CommandResult>;
  kill(): void;
}
export type InteractiveSpawner = (file: string, args: readonly string[], timeoutMs: number) => InteractiveProcess;
