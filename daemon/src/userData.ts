// Mark42가 띄우는 창의 user-data(Mark42 전용)에 늘 맞춰 두는 사용자 설정. 사용자 본인의 VS Code 데이터(%APPDATA%\Code)에는 쓰지 않아요.
import { existsSync, promises as fsp, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { samePath } from '@mark42/protocol/paths';
import { atomicWriteFile, timestampForFile } from './fsutil.ts';
import { errMsg, type Logger } from './log.ts';
import { parseJsonc } from './workspaces.ts';

/**
 * Mark42가 띄우는 창의 user-data(Mark42 전용)에 늘 맞춰 두는 사용자 설정. 모두 application 범위라 워크스페이스
 * 파일로는 안 되고 user-data의 settings.json에 있어야 해요.
 * - update.mode none: 시험 창이 업데이트를 내려받거나 설치기를 띄우지 않게(평소 VS Code와 같은 설치 폴더를 써요).
 * - window.restoreWindows none: 창 복원은 데몬이 해요. VS Code가 복원한 창에는 --disable-extension 등 실행 인자가 없어요.
 * - window.titleBarStyle custom: 역할 워크스페이스의 제목 표시줄 색·제목(workspaces.ts)이 보이게.
 */
export const MANAGED_USER_SETTINGS: Readonly<Record<string, unknown>> = {
  'update.mode': 'none',
  // 에이전트 확장은 데몬이 출처를 검증하고 올려요(agentUpdates.ts) — 앱 자체 자동 업데이트가 Open VSX 판을 검증 없이 깔지 않게
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'window.restoreWindows': 'none',
  'window.titleBarStyle': 'custom',
};

/** 사용자 본인의 VS Code user-data(%APPDATA%\Code) — Mark42가 설정을 쓰면 안 되는 곳 */
export function userDefaultUserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** settings.json 내용 → 객체. 비었거나 주석뿐이면 빈 객체, 객체가 아니거나 JSON 오류면 throw */
export function parseSettingsText(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (e) {
    // 빈 파일·주석뿐인 파일은 VS Code도 빈 설정으로 봐요 — 감싸서 읽어 봐서 키가 하나도 없을 때만 그렇게 봐요
    let wrapped: unknown;
    try {
      wrapped = parseJsonc(`{\n${text}\n}`);
    } catch {
      throw e;
    }
    if (isPlainObject(wrapped) && Object.keys(wrapped).length === 0) return {};
    throw e;
  }
  if (!isPlainObject(parsed)) throw new Error('not a JSON object');
  return parsed;
}

/** 마지막 `}` 앞에서, 문자열·주석 밖의 마지막 의미 있는 글자 위치 (없으면 -1) */
function lastSignificantBefore(text: string, end: number): number {
  let last = -1;
  for (let i = 0; i < end; i++) {
    const c = text[i]!;
    if (c === '"') {
      last = i;
      for (i++; i < end && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      last = i;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < end && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? end : close + 1;
    } else if (!/\s/.test(c)) {
      last = i;
    }
  }
  return last;
}

/**
 * 주석·서식을 지키며 최상위 키를 맞춰요: 단순 값(문자열·숫자·true·false·null)이 이미 있으면 그 값만 바꾸고, 없으면 마지막 `}` 앞에
 * 한 줄 더해요. 결과가 기대대로 읽히지 않으면 undefined(호출한 쪽이 통째로 다시 써요).
 */
export function editSettingsText(text: string, values: Readonly<Record<string, unknown>>): string | undefined {
  let out = text;
  const missing: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`("${k}"\\s*:\\s*)("(?:[^"\\\\\\n]|\\\\.)*"|true|false|null|-?\\d[\\d.eE+-]*)`);
    if (re.test(out)) out = out.replace(re, (_m, head: string) => head + JSON.stringify(value));
    else missing.push(key);
  }
  if (missing.length > 0) {
    const lines = missing.map((k) => `\t${JSON.stringify(k)}: ${JSON.stringify(values[k])}`).join(',\n');
    const close = out.lastIndexOf('}');
    if (close < 0) {
      // 빈 파일·주석뿐: 그 뒤에 새 객체
      out = `${out.trimEnd()}${out.trim() ? '\n' : ''}{\n${lines}\n}\n`;
    } else {
      const last = lastSignificantBefore(out, close);
      const needComma = last >= 0 && out[last] !== '{' && out[last] !== ',';
      const head = needComma ? `${out.slice(0, last + 1)},${out.slice(last + 1, close)}` : out.slice(0, close);
      out = `${head.replace(/[ \t]*$/, '')}${head.endsWith('\n') || /\n[ \t]*$/.test(head) ? '' : '\n'}${lines}\n${out.slice(close)}`;
    }
  }
  try {
    const before = parseSettingsText(text);
    const after = parseSettingsText(out);
    const want = { ...before, ...values };
    if (JSON.stringify(Object.keys(after).sort()) !== JSON.stringify(Object.keys(want).sort())) return undefined;
    for (const [k, v] of Object.entries(want)) if (JSON.stringify(after[k]) !== JSON.stringify(v)) return undefined;
  } catch {
    return undefined;
  }
  return out;
}

/**
 * `dir`(Mark42 전용 user-data)의 User\settings.json에 {@link MANAGED_USER_SETTINGS}를 맞춰요. 다른 키·주석·서식은 그대로 두고
 * ({@link editSettingsText}), 이미 같으면 쓰지 않아요(수정 시각이 바뀌면 버전끼리 설정 맞추기가 이 파일을 «최신»으로 보고 공용
 * 원본과 다른 버전에 퍼뜨려요). 주석을 지키며 고칠 수 없으면 원본을 `settings.json.mk42-bak-<시각>`으로 남기고 통째로 다시 써요.
 * 비었거나 주석뿐인 파일은 빈 설정으로 봐요. 읽을 수 없는 파일(JSON 오류)은 건드리지 않고 경고만 해요. 사용자 기본 user-data는 거절해요.
 */
export async function applyManagedUserSettings(dir: string, log?: Logger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (samePath(dir, userDefaultUserDataDir(env))) {
    log?.warn(`managed user settings: ${dir} is the user's own VS Code data; left alone`);
    return;
  }
  const file = join(dir, 'User', 'settings.json');
  let text = '';
  let current: Record<string, unknown> = {};
  try {
    text = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
    current = parseSettingsText(text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log?.warn(`managed user settings: ${file} not updated (${errMsg(e)})`);
      return;
    }
    text = '';
  }
  const changed = Object.entries(MANAGED_USER_SETTINGS).filter(([k, v]) => current[k] !== v).map(([k]) => k);
  if (changed.length === 0) return;
  try {
    await fsp.mkdir(dirname(file), { recursive: true });
    let next = editSettingsText(text, MANAGED_USER_SETTINGS);
    if (next === undefined) {
      const backup = `${file}.mk42-bak-${timestampForFile()}`;
      await fsp.writeFile(backup, text);
      log?.warn(`managed user settings: ${file} rewritten without its comments; original kept as ${backup}`);
      next = JSON.stringify({ ...current, ...MANAGED_USER_SETTINGS }, null, '\t') + '\n';
    }
    await atomicWriteFile(file, next);
    log?.info(`managed user settings in ${file}: ${changed.join(', ')}`);
  } catch (e) {
    log?.warn(`managed user settings: ${file} not written (${errMsg(e)})`);
  }
}
