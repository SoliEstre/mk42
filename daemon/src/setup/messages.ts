// 설치 엔진(mk42-setup)이 사용자에게 보이는 문구 — 설치 마법사가 `MK42-ERROR` 줄을 오류 상자에 그대로 보여 줘요(2026-11-05 i18n).
// 언어는 마법사가 넘긴 `--lang`(마법사와 늘 같게), 없으면 Windows 표시 언어. 로그는 영어 그대로예요.
import { defineMessages, languageOf, osUiLanguage, type UiLanguage } from '../i18n.ts';

export const setupText = defineMessages({
  en: {
    notHome: '{0} is not a Mk42 install folder (no install record or settings) — nothing was removed',
    busy: 'Some programs are still open: {0} — close them all and uninstall again (setup does not close windows for you).{1}',
    busyElevated: ' One of them may have been started as administrator.',
    hubWindow: 'hub window (mk42-hub)',
    mk42Window: 'Mk42 window',
    elevatedInstall: 'Setup is running as administrator — run it again normally (not «Run as administrator»)',
    elevatedUninstall: 'Uninstall is running as administrator — uninstall again normally (not «Run as administrator»)',
    daemonNotStopped: 'Could not stop the Mk42 daemon — close it (or log off and on) and run setup again',
    daemonNotStarted: 'The Mk42 daemon did not start within 30 seconds — see {0}',
    notRemoved: 'Some files could not be removed (in use?): {0} — remove them by hand',
    shortcutDescription: 'Mk42 hub window',
  },
  ko: {
    notHome: '{0}은(는) Mk42 설치 폴더가 아니에요(설치 기록·설정이 없어요) — 아무것도 지우지 않았어요',
    busy: '열려 있는 프로그램이 있어요: {0} — 모두 닫고 다시 제거해 주세요(창을 대신 닫지 않아요).{1}',
    busyElevated: ' 관리자 권한으로 띄운 창일 수도 있어요.',
    hubWindow: '통합 창(mk42-hub)',
    mk42Window: 'Mk42 창',
    elevatedInstall: '설치가 관리자 권한으로 실행됐어요 — 일반 권한으로 다시 실행해 주세요(«관리자 권한으로 실행» 말고)',
    elevatedUninstall: '제거가 관리자 권한으로 실행됐어요 — 일반 권한으로 다시 제거해 주세요(«관리자 권한으로 실행» 말고)',
    daemonNotStopped: 'Mk42 데몬을 끄지 못했어요 — 데몬을 닫고(또는 로그오프 후 다시 로그온) 설치를 다시 실행해 주세요',
    daemonNotStarted: 'Mk42 데몬이 30초 안에 뜨지 않았어요 — {0}을(를) 확인해 주세요',
    notRemoved: '일부 파일을 지우지 못했어요(사용 중?): {0} — 직접 지워 주세요',
    shortcutDescription: 'Mk42 통합 창',
  },
});

export type SetupTextKey = Parameters<typeof setupText>[1];

/**
 * 로그(영어 `message`)와 사용자 문구(`userText`, 고른 언어)를 함께 든 오류 — 엔진의 끝 catch가 `MK42-ERROR`에 `userText`를 써요.
 * 그 밖의 오류는 영어 메시지 그대로 나가요(마법사가 앞에 «설치하지 못했어요 (코드):»를 붙여요).
 */
export class SetupUserError extends Error {
  readonly userText: string;
  constructor(message: string, userText: string) {
    super(message);
    this.name = 'SetupUserError';
    this.userText = userText;
  }
}

/** 오류 상자에 보일 «닫아 주세요» 문구 — 프로세스 이름을 사람이 아는 이름으로 */
export function busyMessage(lang: UiLanguage, list: ReadonlyArray<{ Name: string; ExecutablePath: string | null }>): string {
  const names = [
    ...new Set(
      list.map((p) =>
        /^mk42-hub\.exe$/i.test(p.Name) ? setupText(lang, 'hubWindow') : /^mk42\.exe$/i.test(p.Name) ? setupText(lang, 'mk42Window') : p.Name,
      ),
    ),
  ];
  const elevated = list.some((p) => !p.ExecutablePath) ? setupText(lang, 'busyElevated') : '';
  return setupText(lang, 'busy', names.join(', '), elevated);
}

/** `--lang`(ko·en·ko-KR …)을 줬으면 그것, 아니면 Windows 표시 언어 */
export function setupLanguage(arg: string | undefined): Promise<UiLanguage> {
  return arg ? Promise.resolve(languageOf(arg)) : osUiLanguage();
}
