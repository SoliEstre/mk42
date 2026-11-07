// 웹뷰(hub UI) → 확장 호스트 전용 알림. 데몬으로 중계하지 않고 확장 호스트가 직접 처리해요.
// 봉투: WebviewToHost {type:'notify', method, params} — method가 'ui.'로 시작하면 호스트 몫이에요.
// 확장 쪽에서 `import type { ... } from '../hub-ui/src/host-messages.ts'`로 가져다 써요(DOM 의존 없음).

export const HUB_UI_COMMANDS = ['mark42.reloadWindow', 'mark42.restartExtensionHost', 'mark42.selectTheme'] as const;
export type HubUiCommand = (typeof HUB_UI_COMMANDS)[number];

export interface HostNotificationMap {
  /** 툴바 버튼: 창 다시 로드 / 확장 다시 로드 / 테마 */
  'ui.command': { command: HubUiCommand };
  /** «폴더 등록»: 호스트가 폴더 선택 대화상자를 띄우고 folders.add를 불러요 */
  'ui.addFolder': Record<string, never>;
}
export type HostNotification = keyof HostNotificationMap;

export const HOST_NOTIFICATION_PREFIX = 'ui.';

export function isHostNotification(method: string): method is HostNotification {
  return method === 'ui.command' || method === 'ui.addFolder';
}

export function isHubUiCommand(v: unknown): v is HubUiCommand {
  return typeof v === 'string' && (HUB_UI_COMMANDS as readonly string[]).includes(v);
}
