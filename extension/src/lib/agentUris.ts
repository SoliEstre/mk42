// 에이전트 확장 URI — 번들에서 읽은 내부 경로라 버전마다 스모크로 확인해요.
//   Claude 2.1.301: registerUriHandler path "/open" ?session=&prompt= → claude-vscode.primaryEditor.open(session, prompt)
//   Codex 26.1007.21434: registerUriHandler(hB) → 사이드바 포커스(Ru) → navigateToRoute(path+query), 웹뷰 라우트 "/local/:conversationId"
//                        custom editor "chatgpt.conversationEditor" ← openai-codex://route/local/<id>

export const CLAUDE_URI_AUTHORITY = 'anthropic.claude-code';
export const CODEX_URI_AUTHORITY = 'openai.chatgpt';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeSessionId(id: string): boolean {
  return ID_RE.test(id);
}

export function claudeOpenUri(uriScheme: string, sessionId?: string, prompt?: string): string {
  const q = new URLSearchParams();
  if (sessionId !== undefined) {
    if (!isSafeSessionId(sessionId)) throw new Error('invalid session id');
    q.set('session', sessionId);
  }
  if (prompt !== undefined && prompt.length > 0) q.set('prompt', prompt);
  const qs = q.toString();
  return `${uriScheme}://${CLAUDE_URI_AUTHORITY}/open${qs ? `?${qs}` : ''}`;
}

export function codexThreadUri(uriScheme: string, threadId: string): string {
  if (!isSafeSessionId(threadId)) throw new Error('invalid thread id');
  return `${uriScheme}://${CODEX_URI_AUTHORITY}/local/${threadId}`;
}

/** vscode.openWith(<이 URI>, 'chatgpt.conversationEditor') — 편집기 탭으로 열 때(대안) */
export function codexConversationEditorUri(threadId: string): string {
  if (!isSafeSessionId(threadId)) throw new Error('invalid thread id');
  return `openai-codex://route/local/${threadId}`;
}
