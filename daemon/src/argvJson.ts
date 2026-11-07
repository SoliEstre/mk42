// C2(2026-11-05): 한국어 Windows에서 Mk42 첫 창이 바로 한국어로 뜨게 `~\.mk42\argv.json`에 `"locale": "ko"`를 넣어요.
// argv.json은 주석이 든 JSONC라 글자 그대로 고쳐요(주석·줄바꿈 유지). 사용자가 고른 locale이 있으면 그대로 둬요.
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from './fsutil.ts';
import { errMsg, type Logger } from './log.ts';

/** Mk42.exe(product dataFolderName `.mk42`)의 argv.json — `<사용자 홈>\.mk42\argv.json` */
export function mk42ArgvJsonPath(userHome: string = homedir()): string {
  return join(userHome, '.mk42', 'argv.json');
}

export interface JsoncTopLevel {
  /** 맨 바깥 객체의 여는 `{` 위치 */
  open: number;
  /** 최상위 키(주석 안의 키는 빼요) */
  keys: string[];
}

/** JSONC 문서의 맨 바깥 객체를 훑어요(주석·문자열 건너뜀). 객체 하나가 아니거나 닫히지 않았으면 undefined */
export function scanJsoncTopLevel(text: string): JsoncTopLevel | undefined {
  const keys: string[] = [];
  let open = -1;
  let depth = 0;
  let closed = false;
  let expectKey = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      i = end + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < n && text[j] !== '"'; j++) {
        if (text[j] === '\\') {
          s += text[j + 1] ?? '';
          j++;
        } else s += text[j];
      }
      if (j >= n) return undefined;
      if (depth === 1 && expectKey) {
        keys.push(s);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0) {
        if (c !== '{' || open >= 0 || closed) return undefined;
        open = i;
        expectKey = true;
      }
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth < 0) return undefined;
      if (depth === 0) closed = true;
    } else if (c === ',' && depth === 1) {
      expectKey = true;
    } else if (depth === 0 && !/\s/.test(c)) {
      // (\s는 BOM U+FEFF도 받아요)
      return undefined; // 객체 밖의 다른 값
    }
    i++;
  }
  return open >= 0 && closed && depth === 0 ? { open, keys } : undefined;
}

export type ArgvLocaleResult = 'created' | 'set' | 'kept' | 'unreadable';

/**
 * argv.json에 locale이 없으면 넣어요. 없는 파일은 locale만 든 작은 객체로 만들어요(나머지 기본 키는 VS Code가 채워요).
 * 이미 locale이 있으면(어떤 값이든) 그대로 'kept', 읽을 수 없는 내용이면 건드리지 않고 'unreadable'.
 */
export async function ensureArgvLocale(file: string, locale: string, log?: Logger): Promise<ArgvLocaleResult> {
  const entry = `"locale": ${JSON.stringify(locale)}`;
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await atomicWriteFile(file, `{\n\t${entry}\n}\n`);
    log?.info(`argv.json created with locale ${locale}: ${file}`);
    return 'created';
  }
  const top = scanJsoncTopLevel(text);
  if (!top) {
    log?.warn(`argv.json not changed (not a JSON object): ${file}`);
    return 'unreadable';
  }
  if (top.keys.includes('locale')) return 'kept';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const at = top.open + 1;
  const rest = text.slice(at);
  // 첫 키 앞에 넣어요 — 뒤에 다른 키가 있으면 쉼표, 바로 닫히는 빈 객체면 줄을 바꿔 닫아요
  const insert = top.keys.length > 0 ? `${eol}\t${entry},` : /^\s*\}/.test(rest) && !/^[ \t]*\r?\n/.test(rest) ? `${eol}\t${entry}${eol}` : `${eol}\t${entry}`;
  try {
    await atomicWriteFile(file, text.slice(0, at) + insert + rest);
  } catch (e) {
    log?.warn(`argv.json locale not written (${errMsg(e)}): ${file}`);
    throw e;
  }
  log?.info(`argv.json locale set to ${locale}: ${file}`);
  return 'set';
}
