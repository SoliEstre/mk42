// 통합 창 테마 동기화(별도 통합 창이 VS Code 테마 색을 따라가게): 확장 API는 테마 «종류»만 알려 주고 색 값은 주지 않아요.
// 그래서 지금 테마(workbench.colorTheme)를 기여한 확장의 테마 파일을 읽고(`include` 사슬 포함), 사용자의
// workbench.colorCustomizations(전체 + `[테마 이름]` 블록)를 덮어 통합 창이 쓰는 색만 뽑아요. vscode 의존 없는 순수 로직이에요.
import { dirname, join } from 'node:path';
import {
  CONTRAST_BORDER_IDS,
  HUB_THEME_COLOR_IDS,
  HUB_THEME_DEFAULTS,
  sanitizeHubTheme,
  type HubTheme,
  type ThemeKind,
} from '@mark42/protocol';

/** JSONC(주석·끝 쉼표) → 값. 테마 파일은 주석이 흔해요. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  // 끝 쉼표: 문자열 밖의 `,` 뒤에 공백만 있고 `}`·`]`
  let res = '';
  let inStr = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (inStr) {
      res += c;
      if (c === '\\') res += out[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j]!)) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    res += c;
  }
  return JSON.parse(res.replace(/^﻿/, ''));
}

export interface ExtensionLike {
  extensionPath: string;
  packageJSON: unknown;
}

interface ThemeContribution {
  id?: string;
  label?: string;
  uiTheme?: string;
  path?: string;
}

export interface ThemeFile {
  path: string;
  /** vs | vs-dark | hc-black | hc-light */
  uiTheme?: string;
}

/** 설정 값(workbench.colorTheme 등)과 같은 테마를 기여한 확장의 테마 파일. VS Code처럼 `id`, 없으면 `label`로 맞춰요. */
export function findThemeFile(extensions: readonly ExtensionLike[], themeName: string): ThemeFile | undefined {
  for (const ext of extensions ?? []) {
    const themes = (ext.packageJSON as { contributes?: { themes?: unknown } })?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    for (const t of themes as ThemeContribution[]) {
      if (!t || typeof t.path !== 'string') continue;
      if ((t.id ?? t.label) === themeName) return { path: join(ext.extensionPath, t.path), ...(t.uiTheme ? { uiTheme: t.uiTheme } : {}) };
    }
  }
  return undefined;
}

const UI_THEME_KIND: Record<string, ThemeKind> = { vs: 'light', 'vs-dark': 'dark', 'hc-black': 'highContrast', 'hc-light': 'highContrastLight' };

export interface ThemeSettings {
  colorTheme?: string;
  preferredDarkColorTheme?: string;
  preferredLightColorTheme?: string;
  preferredHighContrastColorTheme?: string;
  preferredHighContrastLightColorTheme?: string;
  autoDetectColorScheme?: boolean;
  autoDetectHighContrast?: boolean;
}

/**
 * VS Code가 지금 보여 주는 테마 이름(확장 API는 이름을 주지 않아요): 고대비(자동 고대비가 켜져 있고 종류가 고대비) → 선호 고대비
 * 테마, 자동 밝기 전환이 켜져 있으면 → 선호 어두운·밝은 테마, 그다음 workbench.colorTheme. 후보 중 기여한 uiTheme이 지금 종류와 맞는
 * 첫 것, 아무것도 안 맞으면 workbench.colorTheme.
 */
export function resolveActiveThemeName(s: ThemeSettings, kind: ThemeKind, extensions: readonly ExtensionLike[]): string | undefined {
  const candidates: (string | undefined)[] = [];
  if (s.autoDetectHighContrast !== false && (kind === 'highContrast' || kind === 'highContrastLight'))
    candidates.push(kind === 'highContrast' ? s.preferredHighContrastColorTheme : s.preferredHighContrastLightColorTheme);
  if (s.autoDetectColorScheme)
    candidates.push(kind === 'dark' || kind === 'highContrast' ? s.preferredDarkColorTheme : s.preferredLightColorTheme);
  candidates.push(s.colorTheme);
  for (const name of candidates) {
    if (!name) continue;
    const ui = findThemeFile(extensions, name)?.uiTheme;
    if (ui && UI_THEME_KIND[ui] === kind) return name;
  }
  return s.colorTheme;
}

/** 테마 파일의 colors(`include`한 부모 먼저, 자식이 덮음). JSON이 아닌 파일(.tmTheme 등)·읽기 오류는 빈 색이에요. */
export async function loadThemeColors(
  file: string,
  readFile: (p: string) => Promise<string>,
  depth = 0,
): Promise<Record<string, string>> {
  if (depth > 8 || !/\.json$/i.test(file)) return {};
  let doc: unknown;
  try {
    doc = parseJsonc(await readFile(file));
  } catch {
    return {};
  }
  if (typeof doc !== 'object' || doc === null) return {};
  const d = doc as { include?: unknown; colors?: unknown };
  const base = typeof d.include === 'string' ? await loadThemeColors(join(dirname(file), d.include), readFile, depth + 1) : {};
  const own: Record<string, string> = {};
  if (typeof d.colors === 'object' && d.colors !== null) {
    for (const [k, v] of Object.entries(d.colors as Record<string, unknown>)) if (typeof v === 'string') own[k] = v;
  }
  return { ...base, ...own };
}

/** `[테마]` 블록 이름 한 칸이 이 테마에 맞나 — VS Code처럼 정확히, `*가운데*`, `앞*`, `*뒤` */
function scopeMatches(part: string, themeName: string): boolean {
  if (part === themeName) return true;
  if (part.length > 1 && part.startsWith('*') && part.endsWith('*')) return themeName.includes(part.slice(1, -1));
  if (part.endsWith('*')) return themeName.startsWith(part.slice(0, -1));
  if (part.startsWith('*')) return themeName.endsWith(part.slice(1));
  return false;
}

/** workbench.colorCustomizations: 전체 키, 그다음 이 테마에 맞는 `[테마]`·`[A][B]`·`[*Dark*]` 블록(적힌 차례대로, 더 우선) */
export function applyCustomizations(
  colors: Record<string, string>,
  customizations: unknown,
  themeName: string | undefined,
): Record<string, string> {
  if (typeof customizations !== 'object' || customizations === null) return colors;
  const c = customizations as Record<string, unknown>;
  const out = { ...colors };
  for (const [k, v] of Object.entries(c)) if (!k.startsWith('[') && typeof v === 'string') out[k] = v;
  if (!themeName) return out;
  for (const [k, v] of Object.entries(c)) {
    if (!k.startsWith('[') || !k.endsWith(']') || typeof v !== 'object' || v === null) continue;
    const parts = (k.match(/\[(.+?)\]/g) ?? []).map((p) => p.slice(1, -1));
    if (!parts.some((p) => scopeMatches(p, themeName))) continue;
    for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) if (typeof cv === 'string') out[ck] = cv;
  }
  return out;
}

/** vscode.ColorThemeKind(1 Light, 2 Dark, 3 HighContrast, 4 HighContrastLight) → ThemeKind */
export function themeKindOf(kind: number): ThemeKind {
  return kind === 1 ? 'light' : kind === 3 ? 'highContrast' : kind === 4 ? 'highContrastLight' : 'dark';
}

/**
 * 통합 창에 보낼 테마: VS Code 레지스트리 기본값(종류별) < 테마 파일 < 사용자 지정. 고대비 테마가 contrastBorder를 정하면 그걸 따르는
 * 테두리(테마가 따로 정하지 않은 것)도 그 색. 통합 창이 쓰는 색만, 검사한 모양으로.
 */
export async function buildHubTheme(opts: {
  kind: number;
  themeName: string | undefined;
  extensions: readonly ExtensionLike[];
  customizations: unknown;
  readFile: (p: string) => Promise<string>;
}): Promise<HubTheme> {
  const kind = themeKindOf(opts.kind);
  const file = opts.themeName ? findThemeFile(opts.extensions, opts.themeName) : undefined;
  const raw = file ? await loadThemeColors(file.path, opts.readFile) : {};
  const fromTheme = applyCustomizations(raw, opts.customizations, opts.themeName);
  const all: Record<string, string> = { ...HUB_THEME_DEFAULTS[kind] };
  const contrast = fromTheme.contrastBorder;
  if (contrast) for (const id of CONTRAST_BORDER_IDS) all[id] = contrast;
  Object.assign(all, fromTheme);
  const colors: Record<string, string> = {};
  for (const id of HUB_THEME_COLOR_IDS) if (all[id] !== undefined) colors[id] = all[id];
  return sanitizeHubTheme({ kind, name: opts.themeName, colors }) ?? { kind, colors: {} };
}
