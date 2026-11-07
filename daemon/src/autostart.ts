// 로그온 자동 실행 (WBS 3.1) — 작업 스케줄러. 명령 실행기는 주입해요(테스트에서 schtasks를 절대 실행하지 않음).
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { AutostartState } from '@mark42/protocol';

export const TASK_NAME = 'Mark42\\mk42d';
/** D41 이전 이름 — 남아 있으면 get이 보여 주고, set·migrateLegacy가 새 이름으로 옮겨요. */
export const LEGACY_TASK_NAME = 'Mark42\\m42d';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface TaskAction {
  /** node.exe */
  command: string;
  /** [entry, '--boot', ...] */
  args: string[];
  workingDirectory?: string;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 작업 스케줄러 인자 따옴표 — 공백·따옴표가 있으면 "…" 로 감싸요. */
export function quoteArg(a: string): string {
  if (a.length > 0 && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * ONLOGON 트리거를 «현재 사용자»로 한정하려면 /SC ONLOGON 만으로는 안 되고(모든 사용자 로그온), XML의 LogonTrigger.UserId가 필요해요.
 * InteractiveToken + LeastPrivilege 라 관리자 권한 없이 등록하는 걸 목표로 해요(실측 필요).
 */
export function buildTaskXml(action: TaskAction, userId: string): string {
  const args = action.args.map(quoteArg).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Mark42 mk42d daemon (boot resume)</Description>
    <URI>\\${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(action.command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>${
        action.workingDirectory ? `\n      <WorkingDirectory>${xmlEscape(action.workingDirectory)}</WorkingDirectory>` : ''
      }
    </Exec>
  </Actions>
</Task>
`;
}

export function buildCreateArgs(xmlPath: string): string[] {
  return ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'];
}
export function buildDeleteArgs(taskName: string = TASK_NAME): string[] {
  return ['/Delete', '/TN', taskName, '/F'];
}
/** /XML 출력은 로캘과 무관해요(/FO LIST 라벨은 한국어 Windows에서 번역됨). */
export function buildQueryArgs(taskName: string = TASK_NAME): string[] {
  return ['/Query', '/TN', taskName, '/XML'];
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * 작업 스케줄러 인자 문자열 → 인자 배열(CommandLineToArgvW 규칙: 2n개 `\` + `"` → `\` n개 + 따옴표 전환, 2n+1개 → `\` n개 + `"`).
 * quoteArg로 만든 문자열을 그대로 되돌려요.
 */
export function splitTaskArguments(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') {
        n++;
        i++;
      }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
      } else {
        cur += '\\'.repeat(n);
        i--;
      }
      inArg = true;
    } else if (c === '"') {
      quoted = !quoted;
      inArg = true;
    } else if (!quoted && /\s/.test(c)) {
      if (inArg) out.push(cur);
      cur = '';
      inArg = false;
    } else {
      cur += c;
      inArg = true;
    }
  }
  if (inArg) out.push(cur);
  return out;
}

/** /Query /XML 출력에서 첫 Exec 동작을 꺼내요(없으면 undefined). */
export function parseTaskAction(xml: string): TaskAction | undefined {
  const exec = /<Exec>([\s\S]*?)<\/Exec>/.exec(xml)?.[1];
  if (exec === undefined) return undefined;
  const field = (name: string) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(exec);
    return m ? xmlUnescape(m[1]!) : undefined;
  };
  const command = field('Command')?.trim();
  if (!command) return undefined;
  const wd = field('WorkingDirectory')?.trim();
  return { command, args: splitTaskArguments(field('Arguments') ?? ''), ...(wd ? { workingDirectory: wd } : {}) };
}

/**
 * migrateLegacy가 옛 작업의 동작을 보고 정하는 새 동작. undefined면 옮기지 않아요
 * (예: 옛 작업이 이 데몬과 다른 home·pipe를 가리킴 — 시험용 데몬이 사용자 작업을 덮어쓰지 않게).
 */
export type LegacyMigrationPlan = (legacy: TaskAction) => TaskAction | undefined;

export type LegacyMigrationResult =
  /** 옛 작업 없음·꺼짐, 또는 새 작업이 이미 있음 */
  | { outcome: 'none' }
  /** 옛 작업이 이 데몬의 것이 아니거나 동작을 읽지 못해 그대로 둠 */
  | { outcome: 'skipped'; legacy?: TaskAction }
  | { outcome: 'migrated'; action: TaskAction };

/** /Query /XML 결과 → 등록 여부·사용 여부 */
export function parseQueryResult(r: CommandResult): { exists: boolean; enabled: boolean } {
  if (r.code !== 0 || !/<Task[\s>]/.test(r.stdout)) return { exists: false, enabled: false };
  const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(r.stdout)?.[1] ?? '';
  const disabled = /<Enabled>\s*false\s*<\/Enabled>/i.test(settings);
  return { exists: true, enabled: !disabled };
}

export function currentUserId(env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USERNAME ?? userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

export interface AutostartOptions {
  run?: CommandRunner;
  action: TaskAction;
  userId?: string;
  /** XML 임시 파일 위치 */
  tmpDir?: string;
  schtasks?: string;
}

export class Autostart {
  #run: CommandRunner;
  #opts: AutostartOptions;
  constructor(opts: AutostartOptions) {
    this.#opts = opts;
    this.#run = opts.run ?? defaultCommandRunner;
  }

  get #exe(): string {
    return this.#opts.schtasks ?? 'schtasks.exe';
  }

  async #query(taskName: string): Promise<{ exists: boolean; enabled: boolean }> {
    return parseQueryResult(await this.#run(this.#exe, buildQueryArgs(taskName)));
  }

  async #delete(taskName: string): Promise<void> {
    const r = await this.#run(this.#exe, buildDeleteArgs(taskName));
    if (r.code !== 0) throw new Error(`schtasks /Delete failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }

  async get(): Promise<AutostartState> {
    const q = await this.#query(TASK_NAME);
    if (!q.exists) {
      // D41 이전에 등록한 작업만 있으면 그걸 보여 줘요(끄거나 다시 켜면 새 이름으로 정리돼요)
      const legacy = await this.#query(LEGACY_TASK_NAME);
      if (legacy.exists) return { enabled: legacy.enabled, method: 'taskScheduler', taskName: LEGACY_TASK_NAME };
    }
    return { enabled: q.exists && q.enabled, method: 'taskScheduler', taskName: TASK_NAME };
  }

  /**
   * D41 이름 변경: 옛 작업만 켜져 있으면 옛 작업 «자신의» 동작을 plan에 넘겨 새 작업을 만들고 옛 작업을 지워요.
   * 지금 실행 중인 프로세스의 동작이 아니라 옛 작업의 동작(명령·인자·작업 폴더)에서 출발해서, 개발·시험용 데몬이 먼저 떠도
   * 사용자 작업의 --home·--pipe가 바뀌지 않아요. plan이 undefined를 주면(이 데몬의 작업이 아님) 건드리지 않아요.
   * 새 작업이 이미 있거나, 옛 작업이 없거나 꺼져 있으면 아무것도 하지 않아요.
   */
  async migrateLegacy(plan: LegacyMigrationPlan): Promise<LegacyMigrationResult> {
    if ((await this.#query(TASK_NAME)).exists) return { outcome: 'none' };
    const r = await this.#run(this.#exe, buildQueryArgs(LEGACY_TASK_NAME));
    const legacy = parseQueryResult(r);
    if (!legacy.exists || !legacy.enabled) return { outcome: 'none' };
    const legacyAction = parseTaskAction(r.stdout);
    const action = legacyAction && plan(legacyAction);
    if (!action) return { outcome: 'skipped', ...(legacyAction ? { legacy: legacyAction } : {}) };
    await this.#create(action);
    return { outcome: 'migrated', action };
  }

  /** 새 이름으로 작업을 만들고 옛 작업은 지워요. */
  async #create(action: TaskAction): Promise<void> {
    const xml = buildTaskXml(action, this.#opts.userId ?? currentUserId());
    const dir = this.#opts.tmpDir ?? tmpdir();
    await fsp.mkdir(dir, { recursive: true });
    const file = join(dir, `mk42d-task-${process.pid}-${Date.now()}.xml`);
    // schtasks /XML 은 UTF-16 LE(BOM)를 기대해요
    await fsp.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    try {
      const r = await this.#run(this.#exe, buildCreateArgs(file));
      if (r.code !== 0) throw new Error(`schtasks /Create failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    } finally {
      await fsp.unlink(file).catch(() => undefined);
    }
    // 새 작업이 생겼으니 옛 작업은 지워요 — 실패해도 새 작업은 그대로 둬요(둘 다 돌면 두 번째 데몬은 파이프를 보고 물러나요)
    if ((await this.#query(LEGACY_TASK_NAME)).exists) await this.#delete(LEGACY_TASK_NAME).catch(() => undefined);
  }

  /** 지금 등록된 작업(새 이름)의 동작 — 없거나 읽지 못하면 undefined. 설치기가 «이 home의 작업인지» 볼 때 써요. */
  async currentAction(): Promise<TaskAction | undefined> {
    const r = await this.#run(this.#exe, buildQueryArgs(TASK_NAME));
    if (!parseQueryResult(r).exists) return undefined;
    return parseTaskAction(r.stdout);
  }

  async set(enabled: boolean): Promise<AutostartState> {
    if (enabled) {
      await this.#create(this.#opts.action);
    } else {
      for (const name of [TASK_NAME, LEGACY_TASK_NAME]) {
        if ((await this.#query(name)).exists) await this.#delete(name);
      }
    }
    return this.get();
  }
}
