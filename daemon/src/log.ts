// 데몬 로그 — <home>/logs/mk42d.log, 크기 기준 단순 회전(mk42d.log → mk42d.1.log …).
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && v in LEVELS;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** 하위 모듈용 접두사 로거 */
  child(scope: string): Logger;
}

export interface FileLoggerOptions {
  file: string;
  level?: LogLevel;
  maxBytes?: number;
  keep?: number;
  /** 콘솔에도 출력 (포그라운드 실행) */
  echo?: boolean;
}

export function createFileLogger(opts: FileLoggerOptions): Logger {
  const level = LEVELS[opts.level ?? 'info'];
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  let size = -1;
  try {
    mkdirSync(dirname(opts.file), { recursive: true });
  } catch {
    // 로그 폴더를 못 만들면 콘솔만
  }
  const rotate = () => {
    try {
      rmSync(rotated(opts.file, keep), { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        try {
          renameSync(rotated(opts.file, i), rotated(opts.file, i + 1));
        } catch {
          // 없는 회전 파일
        }
      }
      renameSync(opts.file, rotated(opts.file, 1));
    } catch {
      // 다른 프로세스가 잡고 있으면 이번엔 건너뜀
    }
    size = 0;
  };
  const write = (lv: LogLevel, scope: string, msg: string) => {
    if (LEVELS[lv] < level) return;
    const line = `${new Date().toISOString()} ${lv.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ''}${msg}\n`;
    if (opts.echo) (lv === 'error' || lv === 'warn' ? process.stderr : process.stdout).write(line);
    try {
      if (size < 0) {
        try {
          size = statSync(opts.file).size;
        } catch {
          size = 0;
        }
      }
      if (size + line.length > maxBytes) rotate();
      appendFileSync(opts.file, line);
      size += Buffer.byteLength(line);
    } catch {
      // 디스크 오류로 데몬이 죽지 않게
    }
  };
  const make = (scope: string): Logger => ({
    debug: (m) => write('debug', scope, m),
    info: (m) => write('info', scope, m),
    warn: (m) => write('warn', scope, m),
    error: (m) => write('error', scope, m),
    child: (s) => make(scope ? `${scope}/${s}` : s),
  });
  return make('');
}

function rotated(file: string, i: number): string {
  const dir = dirname(file);
  const base = file.slice(dir.length + 1).replace(/\.log$/, '');
  return join(dir, `${base}.${i}.log`);
}

/** 테스트·임베드용: 메모리에 모으거나 버려요. */
export function createMemoryLogger(sink?: string[]): Logger {
  const make = (scope: string): Logger => {
    const w = (lv: LogLevel) => (m: string) => {
      sink?.push(`${lv} ${scope ? `[${scope}] ` : ''}${m}`);
    };
    return { debug: w('debug'), info: w('info'), warn: w('warn'), error: w('error'), child: (s) => make(scope ? `${scope}/${s}` : s) };
  };
  return make('');
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
