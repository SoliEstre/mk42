// 역할별 .code-workspace (architecture §3.1, ADR 0003).
// <home>/roles/<folderId>/<role>[.<slotId>].code-workspace — 파일 경로가 다르면 VS Code가 별개 워크스페이스로 봐서
// 같은 폴더를 agent 창과 editor 창으로 따로 열 수 있어요.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { WindowRole } from '@mark42/protocol';
import { folderIdFor, normalizePath } from '@mark42/protocol/paths';
import { atomicWriteFile, timestampForFile } from './fsutil.ts';

/**
 * D21 — 업스트림 Agents 창·내장 Agent Host 끄기. 공식 VS Code 1.141.1·1.142.0 번들(workbench.desktop.main.js)의
 * 설정 스키마에서 확인한 키예요(2026-10-17).
 * - chat.agentHost.claudeAgent.enabled: 기본 true, scope 미지정(=window) → 워크스페이스 설정으로 꺼져요.
 * - chat.agentHost.codexAgent.enabled / chat.editor.codex.preferAgentHost: stable 기본 false. 명시만 해 둬요.
 * - chat.agentsControl.enabled: enum hidden|badge|compact(기본 compact) — 타이틀 바 Agents 컨트롤.
 * - chat.titleBar.openInAgentsWindow.enabled: 기본 true — 타이틀 바 «Agents 창에서 열기» 진입점.
 * - chat.agentsWindowBanner.enabled: scope 1(APPLICATION)이라 워크스페이스 파일에서는 무시돼요(1.141.1에는 키 자체가 없음). 해는 없어요.
 * - chat.agentsParallelWorkBanner.enabled·chat.agentsHandoffTip.mode: deprecated(→ agentsWindowBanner로 마이그레이션). 넣지 않아요.
 * - Agents 창 진입점을 전부 숨기는 단일 설정은 없어요(패치 빌드에서 처리). 버전이 바뀌면 키가 바뀔 수 있어서 한곳에 모아 둬요.
 */
export const AGENT_HOST_OFF_SETTINGS: Readonly<Record<string, unknown>> = {
  'chat.agentHost.claudeAgent.enabled': false,
  'chat.agentHost.codexAgent.enabled': false,
  'chat.editor.codex.preferAgentHost': false,
  'chat.agentsControl.enabled': 'hidden',
  'chat.titleBar.openInAgentsWindow.enabled': false,
  'chat.agentsWindowBanner.enabled': false,
};

/** 예전 버전(이전 실행)이 쓰던 관리 키 — 다시 쓸 때 지워요. */
const RETIRED_KEYS: readonly string[] = ['chat.agentsParallelWorkBanner.enabled', 'chat.agentsHandoffTip.mode'];

/**
 * Daemon/005 §4-5 — 평소 VS Code 창과 한눈에 구분되게: 제목 앞 «[Mk42 …]»(앱 이름 «Visual Studio Code»는 빼요)와 Mk42 색(빨간 판 +
 * 금색 글자)의 제목 표시줄·상태 표시줄. `window.title`은 관리 키라 통째로 다시 쓰고, 색은 `workbench.colorCustomizations` 안의 이
 * 하위 키만 맞춰요(사용자가 넣은 다른 색은 그대로).
 */
export const ROLE_TITLE_LABELS: Readonly<Record<WindowRole, string>> = {
  hub: '허브',
  'agent-claude': 'Claude',
  'agent-codex': 'Codex',
  editor: '편집',
};
export const MK42_COLORS: Readonly<Record<string, string>> = {
  'titleBar.activeBackground': '#7a1018',
  'titleBar.activeForeground': '#f7cd5c',
  'titleBar.inactiveBackground': '#4a0a10',
  'titleBar.inactiveForeground': '#c9a24a',
  'statusBar.background': '#7a1018',
  'statusBar.foreground': '#f7cd5c',
  'statusBar.noFolderBackground': '#7a1018',
  'statusBar.noFolderForeground': '#f7cd5c',
};
const COLOR_KEY = 'workbench.colorCustomizations';

/**
 * 에이전트 창은 대괄호 안에 세션 이름을 붙여요: «[Mk42 Claude: 세션 이름] …»(작업 표시줄에서 창을 구분하게).
 * `${mark42Session}`은 Mark42 확장이 «: 이름» 또는 빈 값으로 채우는 창 제목 변수예요(extension/src/windowTitle.ts) — 비어 있으면
 * 예전 제목과 글자까지 같아요(구분자 규칙에 기대지 않게 대괄호 안 글자로 둬요).
 */
export function roleWindowTitle(role: WindowRole): string {
  const session = role === 'agent-claude' || role === 'agent-codex' ? '${mark42Session}' : '';
  return `[Mk42 ${ROLE_TITLE_LABELS[role]}${session}] \${dirty}\${activeEditorShort}\${separator}\${rootName}`;
}

/** Mark42가 관리하는 키 — 이 키들만 다시 써요. 나머지(사용자가 고른 workbench.colorTheme 등)는 보존해요. */
export const MANAGED_KEYS: readonly string[] = [
  'mark42.role',
  'mark42.slotId',
  'mark42.folderPath',
  'mark42.pipeName',
  'window.title',
  'window.autoDetectColorScheme',
  'workbench.secondarySideBar.defaultVisibility',
  'workbench.secondarySideBar.forceMaximized',
  'workbench.activityBar.location',
  'workbench.view.alwaysShowHeaderActions',
  'extensions.autoRestart',
  'claudeCode.preferredLocation',
  ...Object.keys(AGENT_HOST_OFF_SETTINGS),
];

export const HUB_DIR_NAME = '_hub';

export function isAgentRole(role: WindowRole): role is 'agent-claude' | 'agent-codex' {
  return role === 'agent-claude' || role === 'agent-codex';
}

export function validSlotId(slotId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(slotId);
}

export interface RoleWorkspaceSpec {
  home: string;
  role: WindowRole;
  /** hub는 없어도 돼요 */
  folderPath?: string;
  /** agent 역할 필수 */
  slotId?: string;
  /** 기본 파이프가 아닐 때만(--pipe·--home·MARK42_PIPE) — 창 확장이 이 이름으로 붙어요 */
  pipeName?: string;
}

export function roleWorkspacePath(spec: RoleWorkspaceSpec): string {
  const { home, role } = spec;
  if (role === 'hub') return join(home, 'roles', HUB_DIR_NAME, 'hub.code-workspace');
  if (!spec.folderPath) throw new Error(`folderPath required for role ${role}`);
  const dir = join(home, 'roles', folderIdFor(spec.folderPath));
  if (isAgentRole(role)) {
    if (!spec.slotId || !validSlotId(spec.slotId)) throw new Error(`valid slotId required for role ${role}`);
    return join(dir, `${role}.${spec.slotId}.code-workspace`);
  }
  return join(dir, `${role}.code-workspace`);
}

/** 역할별 관리 설정. undefined 값은 «있으면 지움»이에요. */
export function managedSettings(spec: Omit<RoleWorkspaceSpec, 'home'>): Record<string, unknown> {
  const { role } = spec;
  const s: Record<string, unknown> = {
    'mark42.role': role,
    'mark42.slotId': isAgentRole(role) ? spec.slotId : undefined,
    'mark42.folderPath': spec.folderPath ? normalizePath(spec.folderPath) : undefined,
    'mark42.pipeName': spec.pipeName || undefined,
    'window.title': roleWindowTitle(role),
    'window.autoDetectColorScheme': false,
    ...AGENT_HOST_OFF_SETTINGS,
  };
  if (isAgentRole(role)) {
    s['workbench.secondarySideBar.defaultVisibility'] = 'maximizedInWorkspace';
    // 1.143.1 실험 설정: 열린 편집기 목록이 바뀌어 비게 되면 보조 사이드바(에이전트 패널)를 다시 최대화해요. 활동 막대를 눌러
    // 최대화가 풀린 뒤 사이드바만 닫아서는 돌아오지 않아요(편집기를 열었다 다 닫으면 돌아옴, Daemon/007 §4). 없는 버전에서는 무시돼요.
    s['workbench.secondarySideBar.forceMaximized'] = true;
    // 왼쪽 활동 막대 숨김(2026-10-26 사용자 요청): 아이콘을 눌러 최대화가 풀리는 길을 없애요. 기본 사이드바는 Ctrl+B로만 열리고,
    // 닫아도 자동으로 다시 최대화되지 않아요 — 상태 표시줄 «에이전트 패널 크게»로 돌려요(사이드바 보임 여부는 확장 API에 없음).
    s['workbench.activityBar.location'] = 'hidden';
    // stable 빌드에서는 스키마에 없는 키예요(included: quality !== 'stable'). 기본값도 false라 표시만.
    s['extensions.autoRestart'] = false;
    s['claudeCode.preferredLocation'] = role === 'agent-claude' ? 'sidebar' : undefined;
    // 에이전트 패널 아래·위에 «작업» 보기가 있어 보기 머리가 둘이에요 — Mark42 단추(버전·업데이트·다시 로드)가 마우스를 올려야만 보이지 않게
    s['workbench.view.alwaysShowHeaderActions'] = true;
  } else {
    s['workbench.secondarySideBar.defaultVisibility'] = 'hidden';
    s['workbench.secondarySideBar.forceMaximized'] = undefined;
    s['workbench.activityBar.location'] = undefined;
    s['extensions.autoRestart'] = undefined;
    s['claudeCode.preferredLocation'] = undefined;
    s['workbench.view.alwaysShowHeaderActions'] = undefined;
  }
  return s;
}

/** JSONC(주석·끝 쉼표) → JSON. VS Code가 쓰는 워크스페이스 파일에 주석이 들어갈 수 있어요. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(removeTrailingCommas(out).replace(/^﻿/, ''));
}

function removeTrailingCommas(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += s[i + 1] ?? '';
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

export interface WorkspaceFileContent {
  folders: { path: string; name?: string }[];
  settings: Record<string, unknown>;
  [k: string]: unknown;
}

/** 기존 내용과 관리 설정을 합쳐요. 관리 키만 덮어쓰고 나머지는 보존해요. */
export function mergeWorkspace(existing: unknown, spec: Omit<RoleWorkspaceSpec, 'home'>): WorkspaceFileContent {
  const base: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? { ...(existing as object) } : {};
  const oldSettings =
    typeof base.settings === 'object' && base.settings !== null && !Array.isArray(base.settings)
      ? (base.settings as Record<string, unknown>)
      : {};
  const settings: Record<string, unknown> = { ...oldSettings };
  for (const k of RETIRED_KEYS) delete settings[k];
  for (const [k, v] of Object.entries(managedSettings(spec))) {
    if (v === undefined) delete settings[k];
    else settings[k] = v;
  }
  const oldColors = settings[COLOR_KEY];
  settings[COLOR_KEY] = {
    ...(typeof oldColors === 'object' && oldColors !== null && !Array.isArray(oldColors) ? oldColors : {}),
    ...MK42_COLORS,
  };
  const folders = spec.folderPath ? [{ path: normalizePath(spec.folderPath) }] : [];
  return { ...base, folders, settings } as WorkspaceFileContent;
}

export interface EnsureResult {
  file: string;
  created: boolean;
  changed: boolean;
}

/** 워크스페이스 파일을 만들거나 관리 키만 갱신해요. 바뀐 게 없으면 쓰지 않아요(열린 창의 설정 재적용 방지). */
export async function ensureRoleWorkspace(spec: RoleWorkspaceSpec): Promise<EnsureResult> {
  const file = roleWorkspacePath(spec);
  await fsp.mkdir(join(file, '..'), { recursive: true });
  let existing: unknown;
  let created = false;
  let text: string | undefined;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    created = true;
  }
  if (text !== undefined) {
    try {
      existing = parseJsonc(text);
    } catch {
      const backup = `${file}.corrupt-${timestampForFile()}`;
      await fsp.rename(file, backup).catch(() => undefined);
      existing = undefined;
      created = true;
    }
  }
  const merged = mergeWorkspace(existing, spec);
  if (text !== undefined && !created && JSON.stringify(existing) === JSON.stringify(merged)) {
    return { file, created: false, changed: false };
  }
  await atomicWriteFile(file, JSON.stringify(merged, null, '\t') + '\n');
  return { file, created, changed: true };
}
