// 에이전트 창 레이아웃: 에이전트 패널(보조 사이드바)이 창을 꽉 채우게. `maximizedInWorkspace`는 처음 한 번만 적용되고, 활동 막대를
// 누르거나 편집기를 열면 최대화가 풀린 채 다음 실행에도 그대로 복원돼요(2026-10-26 사용자 보고). 그래서 창이 뜰 때와 편집기가 모두
// 닫힐 때 `workbench.action.maximizeAuxiliaryBar`(켜기만 하는 명령, 여러 번 불러도 같음)를 불러요. 상태 표시줄 단추도 같은 명령이에요.
import * as vscode from 'vscode';

export const MAXIMIZE_AUX_COMMAND = 'workbench.action.maximizeAuxiliaryBar';

/** 창이 복원을 끝낼 시간 — 그 전에 부르면 복원된 레이아웃이 덮어써요 */
export const STARTUP_DELAY_MS = 1500;

export async function maximizeAgentPanel(): Promise<void> {
  try {
    await vscode.commands.executeCommand(MAXIMIZE_AUX_COMMAND);
  } catch {
    // 이 명령이 없는 버전
  }
}

function anyTabs(): boolean {
  return vscode.window.tabGroups.all.some((g) => g.tabs.length > 0);
}

/**
 * 에이전트 역할 창이면(`isAgent()`가 true): 뜬 뒤 {@link STARTUP_DELAY_MS}에 편집기가 없으면 최대화, 그 뒤 탭이 닫혀 편집기가
 * 하나도 없게 되면 최대화. 편집기를 여는 것은 막지 않아요(사용자가 연 파일).
 */
export function watchAgentLayout(isAgent: () => boolean, delayMs = STARTUP_DELAY_MS): vscode.Disposable {
  const timer = setTimeout(() => {
    if (isAgent() && !anyTabs()) void maximizeAgentPanel();
  }, delayMs);
  const sub = vscode.window.tabGroups.onDidChangeTabs((e) => {
    if (e.closed.length > 0 && isAgent() && !anyTabs()) void maximizeAgentPanel();
  });
  return {
    dispose: () => {
      clearTimeout(timer);
      sub.dispose();
    },
  };
}
