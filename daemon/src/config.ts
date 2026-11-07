// mk42d 명령줄 인자.
import { win32 } from 'node:path';
import { defaultMark42Home, defaultPipeName } from '@mark42/protocol/paths';
import type { TaskAction } from './autostart.ts';
import { isLogLevel, type LogLevel } from './log.ts';

export interface DaemonArgs {
  home: string;
  pipe: string;
  logLevel: LogLevel;
  hubServer: boolean;
  /** 로그온 작업에서 실행 — 부팅 재개(D28) */
  boot: boolean;
  /** 통합 창 (B) 띄우기(Mk42 통합 창 exe, 없으면 Edge — D46). 이미 실행 중이면 기존 데몬에 부탁해요 */
  openHub: boolean;
  help: boolean;
}

export const USAGE = `mk42d — Mark42 daemon
  --home <dir>         data folder (default %LOCALAPPDATA%\\Mark42 or MARK42_HOME)
  --pipe <name>        named pipe (default derived from user + home, or MARK42_PIPE)
  --log-level <lvl>    debug | info | warn | error (default info)
  --no-hub-server      do not start the loopback hub (B) server
  --boot               run boot resume (logon task)
  --open-hub           open the hub (B) window (Mk42 hub exe, else Edge --app)
  --help`;

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

/**
 * 창 확장은 MARK42_* 환경 변수 없이 defaultPipeName()으로 붙어요. 데몬 파이프가 그 이름과 다르면
 * 역할 워크스페이스에 mark42.pipeName으로 알려 줘야 해요(다르지 않으면 undefined).
 */
export function pipeNameForWindows(pipe: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const plain: NodeJS.ProcessEnv = { ...env };
  delete plain.MARK42_PIPE;
  delete plain.MARK42_HOME;
  return pipe === defaultPipeName(plain) ? undefined : pipe;
}

/**
 * 로그온 작업 인자. 작업은 셸에서만 설정한 MARK42_HOME·MARK42_PIPE를 물려받지 못해서
 * 등록한 데몬의 실제 home·pipe를 항상 그대로 넘겨요.
 */
export function autostartEntryArgs(entry: string, args: Pick<DaemonArgs, 'home' | 'pipe'>): string[] {
  return [entry, '--boot', '--home', args.home, '--pipe', args.pipe];
}

function sameWindowsPath(a: string, b: string): boolean {
  const norm = (p: string) => win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * D41 옛 로그온 작업(`Mark42\m42d`) → 새 작업의 동작. 옛 작업 인자의 --home·--pipe(없으면 기본값)가 이 데몬과 같을 때만 옮겨요
 * (아니면 undefined — 시험·개발용 데몬이 사용자의 작업을 자기 home·pipe로 바꾸지 않게). 명령·인자·작업 폴더는 옛 작업 그대로 두고,
 * 진입 파일이 옛 번들 `m42d.mjs`(·.cjs·.js)이고 옆에 `mk42d.*`가 있을 때만 새 번들로 바꿔요.
 */
export function legacyTaskMigration(
  legacy: TaskAction,
  args: Pick<DaemonArgs, 'home' | 'pipe'>,
  opts: { exists: (path: string) => boolean; env?: NodeJS.ProcessEnv },
): TaskAction | undefined {
  const [entry, ...rest] = legacy.args;
  if (!entry) return undefined;
  let theirs: DaemonArgs;
  try {
    theirs = parseArgs(rest, opts.env ?? process.env);
  } catch {
    return undefined; // 이 데몬이 모르는 인자 — 손대지 않아요
  }
  if (!sameWindowsPath(theirs.home, args.home) || theirs.pipe.toLowerCase() !== args.pipe.toLowerCase()) return undefined;
  const m = /^(.*[\\/])?m42d\.(mjs|cjs|js)$/i.exec(entry);
  const renamed = m ? `${m[1] ?? ''}mk42d.${m[2]!}` : undefined;
  const next = renamed && opts.exists(renamed) ? renamed : entry;
  return { ...legacy, args: [next, ...rest] };
}

/** 이 변수가 있으면 이미 콘솔 없이 다시 띄운 프로세스예요 */
export const DETACHED_ENV = 'M42D_DETACHED';

export interface RespawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * 로그온 작업은 node.exe(콘솔 프로그램)를 바로 실행해서 콘솔(또는 Windows Terminal) 창이 떠요. 그 창을 닫으면 데몬도 죽어요.
 * --boot면 콘솔 없이(detached + windowsHide) 자기 자신을 다시 띄우고 부모는 끝내요.
 */
export function bootRespawnPlan(
  args: Pick<DaemonArgs, 'boot'>,
  execPath: string,
  execArgv: readonly string[],
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): RespawnPlan | undefined {
  if (!args.boot || platform !== 'win32' || env[DETACHED_ENV] === '1') return undefined;
  return { command: execPath, args: [...execArgv, ...argv.slice(1)], env: { ...env, [DETACHED_ENV]: '1' } };
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DaemonArgs {
  let home: string | undefined;
  let pipe: string | undefined;
  let logLevel: LogLevel = 'info';
  let hubServer = true;
  let boot = false;
  let openHub = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const value = (): string => {
      if (eq >= 0) return raw.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new ArgError(`${name} needs a value`);
      return v;
    };
    switch (name) {
      case '--home':
        home = value();
        break;
      case '--pipe':
        pipe = value();
        break;
      case '--log-level': {
        const v = value();
        if (!isLogLevel(v)) throw new ArgError(`invalid --log-level ${v}`);
        logLevel = v;
        break;
      }
      case '--no-hub-server':
        hubServer = false;
        break;
      case '--boot':
        boot = true;
        break;
      case '--open-hub':
        openHub = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new ArgError(`unknown argument ${raw}`);
    }
  }
  const resolvedHome = home ?? defaultMark42Home(env);
  return {
    home: resolvedHome,
    pipe: pipe ?? defaultPipeName({ ...env, MARK42_HOME: resolvedHome }),
    logLevel,
    hubServer,
    boot,
    openHub,
    help,
  };
}
