// 사용자에게 보이는 데몬·설치 엔진 문구의 언어(2026-11-05) — Windows 표시 언어가 한국어면 ko, 아니면 en. 로그는 영어 그대로예요.
// 모듈마다 자기 문구 표를 `defineMessages`로 두고(한 파일에 모으면 여러 작업이 같은 줄을 고쳐요), 언어는 `osUiLanguage()` 하나로 정해요.
import { execFile } from 'node:child_process';

export type UiLanguage = 'en' | 'ko';

/** `ko`, `ko-KR`, `ko_KR` … → ko, 나머지 → en */
export function languageOf(tag: string | undefined | null): UiLanguage {
  return /^ko(?:$|[-_])/i.test((tag ?? '').trim()) ? 'ko' : 'en';
}

/** `reg query <key> /v <name>` 출력에서 REG_MULTI_SZ·REG_SZ 값의 첫 항목(멀티 문자열은 `\0`으로 이어져 나와요) */
export function parseRegFirstValue(stdout: string, name: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s{4}(REG_MULTI_SZ|REG_SZ)\s{4}(.*)$/.exec(line);
    if (m && m[1]!.toLowerCase() === name.toLowerCase()) {
      const first = m[3]!.split('\\0')[0]!.trim();
      return first || undefined;
    }
  }
  return undefined;
}

function regQuery(key: string, name: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 5_000 }, (err, stdout) =>
      resolve(err ? undefined : parseRegFirstValue(stdout, name)),
    ),
  );
}

/** Windows 표시 언어 태그(예: ko-KR). 사용자 설정 → 언어 목록 첫 항목 → ICU 기본 로캘 순서 */
export async function detectOsUiLanguageTag(platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform === 'win32') {
    const tag =
      (await regQuery('HKCU\\Control Panel\\Desktop', 'PreferredUILanguages')) ??
      (await regQuery('HKCU\\Control Panel\\International\\User Profile', 'Languages'));
    if (tag) return tag;
  }
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

let cached: UiLanguage | undefined;
let pending: Promise<UiLanguage> | undefined;

/** 한 번 재고 기억해요. 시험에서는 {@link setOsUiLanguageForTest} */
export function osUiLanguage(): Promise<UiLanguage> {
  if (cached) return Promise.resolve(cached);
  pending ??= detectOsUiLanguageTag().then(
    (tag) => (cached = languageOf(tag)),
    () => (cached = languageOf(Intl.DateTimeFormat().resolvedOptions().locale)),
  );
  return pending;
}

/** 이미 잰 값(아직이면 ICU 로캘로 짐작) — 동기 문맥용 */
export function osUiLanguageSync(): UiLanguage {
  return cached ?? languageOf(Intl.DateTimeFormat().resolvedOptions().locale);
}

export function setOsUiLanguageForTest(lang: UiLanguage | undefined): void {
  cached = lang;
  pending = undefined;
}

export type MessageTable<K extends string> = Readonly<Record<UiLanguage, Readonly<Record<K, string>>>>;

/**
 * 모듈 문구 표 → `t(lang, key, ...args)`. 자리 표시 `{0}`·`{1}`… 는 args로 채워요. ko 표에 빠진 키는 en으로.
 * 예: `const t = defineMessages({ en: { hi: 'Hi {0}' }, ko: { hi: '{0}님 안녕하세요' } }); t('ko', 'hi', 'A')`
 */
export function defineMessages<K extends string>(table: MessageTable<K>): (lang: UiLanguage, key: K, ...args: Array<string | number>) => string {
  return (lang, key, ...args) => {
    const template = table[lang][key] ?? table.en[key] ?? key;
    return template.replace(/\{(\d+)\}/g, (all, i: string) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : all));
  };
}
