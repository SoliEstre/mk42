// 통합 창 테마 동기화 — Mark42 VS Code 창(확장)이 지금 테마의 색을 데몬에 알리고(`window.theme`), 별도 통합 창(B)이 `theme.get`으로
// 받아 같은 이름의 CSS 변수(`--vscode-<id에서 . → ->`)로 넣어요. 웹뷰 통합 창(A)은 VS Code가 그 변수를 직접 넣어 줘요.

export type ThemeKind = 'light' | 'dark' | 'highContrast' | 'highContrastLight';

export interface HubTheme {
  kind: ThemeKind;
  /** workbench.colorTheme 값(로그·표시용) */
  name?: string;
  /** VS Code 색 ID → `#rgb`·`#rrggbb`·`#rrggbbaa`. {@link HUB_THEME_COLOR_IDS} 안의 것만, 테마에 없는 색은 빠져요 */
  colors: Record<string, string>;
}

/** 통합 창 화면(extension/hub-ui/src/hub-ui.css)이 쓰는 VS Code 색 ID — CSS를 바꾸면 이 목록도 같이 */
export const HUB_THEME_COLOR_IDS: readonly string[] = [
  'foreground',
  'descriptionForeground',
  'errorForeground',
  'focusBorder',
  'widget.border',
  'sideBar.background',
  'editor.background',
  'editorWidget.background',
  'editorWarning.foreground',
  'panel.border',
  'list.hoverBackground',
  'button.background',
  'button.foreground',
  'button.hoverBackground',
  'button.secondaryBackground',
  'button.secondaryForeground',
  'button.secondaryHoverBackground',
  'input.background',
  'input.foreground',
  'input.border',
  'testing.iconPassed',
  'textLink.foreground',
];

/**
 * VS Code 색 레지스트리 기본값(1.143.1 workbench.desktop.main.js에서 확인, 2026-10-26) — 테마 파일에 없는 색은 VS Code가 이 값을
 * 쓰니까(Dark+·Light+·고대비는 테마 파일에 이 색들이 거의 없어요) 통합 창도 이 값에서 시작해요. 계산되는 색(밝게·어둡게·투명)은
 * 그 결과를 적어 뒀어요. 레지스트리가 null(그리지 않음)인 색은 빠져요.
 */
export const HUB_THEME_DEFAULTS: Readonly<Record<ThemeKind, Readonly<Record<string, string>>>> = {
  dark: {
    foreground: '#cccccc',
    descriptionForeground: '#ccccccb3',
    errorForeground: '#f48771',
    focusBorder: '#007fd4',
    'sideBar.background': '#252526',
    'editor.background': '#1e1e1e',
    'editorWidget.background': '#252526',
    'editorWarning.foreground': '#cca700',
    'panel.border': '#80808059',
    'list.hoverBackground': '#2a2d2e',
    'button.background': '#0e639c',
    'button.foreground': '#ffffff',
    'button.hoverBackground': '#1177bb',
    'button.secondaryBackground': '#2a2d2e',
    'button.secondaryForeground': '#cccccc',
    'button.secondaryHoverBackground': '#323637',
    'input.background': '#3c3c3c',
    'input.foreground': '#cccccc',
    'testing.iconPassed': '#73c991',
    'textLink.foreground': '#3794ff',
  },
  light: {
    foreground: '#616161',
    descriptionForeground: '#717171',
    errorForeground: '#a1260d',
    focusBorder: '#0090f1',
    'sideBar.background': '#f3f3f3',
    'editor.background': '#ffffff',
    'editorWidget.background': '#f3f3f3',
    'editorWarning.foreground': '#bf8803',
    'panel.border': '#80808059',
    'list.hoverBackground': '#f0f0f0',
    'button.background': '#007acc',
    'button.foreground': '#ffffff',
    'button.hoverBackground': '#0062a3',
    'button.secondaryBackground': '#f0f0f0',
    'button.secondaryForeground': '#616161',
    'button.secondaryHoverBackground': '#ffffff',
    'input.background': '#ffffff',
    'input.foreground': '#616161',
    'testing.iconPassed': '#73c991',
    'textLink.foreground': '#006ab1',
  },
  highContrast: {
    foreground: '#ffffff',
    descriptionForeground: '#ffffffb3',
    errorForeground: '#f48771',
    focusBorder: '#f38518',
    'widget.border': '#6fc3df',
    'sideBar.background': '#000000',
    'editor.background': '#000000',
    'editorWidget.background': '#0c141f',
    'editorWarning.foreground': '#ffd370',
    'panel.border': '#6fc3df',
    'list.hoverBackground': '#ffffff1a',
    'button.background': '#000000',
    'button.foreground': '#ffffff',
    'button.hoverBackground': '#000000',
    'button.secondaryForeground': '#ffffff',
    'input.background': '#000000',
    'input.foreground': '#ffffff',
    'input.border': '#6fc3df',
    'testing.iconPassed': '#73c991',
    'textLink.foreground': '#21a6ff',
  },
  highContrastLight: {
    foreground: '#292929',
    descriptionForeground: '#292929b3',
    errorForeground: '#b5200d',
    focusBorder: '#006bbd',
    'widget.border': '#0f4a85',
    'sideBar.background': '#ffffff',
    'editor.background': '#ffffff',
    'editorWidget.background': '#ffffff',
    'editorWarning.foreground': '#895503',
    'panel.border': '#0f4a85',
    'list.hoverBackground': '#0f4a851a',
    'button.background': '#0f4a85',
    'button.foreground': '#ffffff',
    'button.hoverBackground': '#0f4a85',
    'button.secondaryBackground': '#ffffff',
    'button.secondaryForeground': '#292929',
    'input.background': '#ffffff',
    'input.foreground': '#292929',
    'input.border': '#0f4a85',
    'testing.iconPassed': '#007100',
    'textLink.foreground': '#0f4a85',
  },
};

/** 고대비 테마의 contrastBorder가 정하는 테두리 색들(레지스트리에서 contrastBorder를 따르는 것) */
export const CONTRAST_BORDER_IDS: readonly string[] = ['widget.border', 'panel.border', 'input.border'];

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const KINDS: readonly ThemeKind[] = ['light', 'dark', 'highContrast', 'highContrastLight'];

/** 받은 테마를 믿을 수 있는 모양으로: 알려진 종류, 목록 안의 ID, 16진 색만(CSS에 그대로 넣으니까). 아니면 undefined */
export function sanitizeHubTheme(raw: unknown): HubTheme | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !(KINDS as readonly string[]).includes(r.kind)) return undefined;
  const colors: Record<string, string> = {};
  if (typeof r.colors === 'object' && r.colors !== null) {
    for (const id of HUB_THEME_COLOR_IDS) {
      const v = (r.colors as Record<string, unknown>)[id];
      if (typeof v === 'string' && COLOR.test(v)) colors[id] = v.toLowerCase();
    }
  }
  const name = typeof r.name === 'string' && r.name.length <= 200 ? r.name : undefined;
  return { kind: r.kind as ThemeKind, ...(name ? { name } : {}), colors };
}

/** CSS 변수 이름: VS Code 웹뷰와 같은 규칙(`button.secondaryBackground` → `--vscode-button-secondaryBackground`) */
export function themeCssVar(id: string): string {
  return `--vscode-${id.replace(/\./g, '-')}`;
}
