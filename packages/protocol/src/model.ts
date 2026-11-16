// 모델 표시 — 확장(작업 보기)과 통합 창이 같이 써요.

/** 모델 id를 짧게: claude-opus-5-5 → «Opus 5.5», claude-sonnet-5-5-20261001 → «Sonnet 5.5». 다른 모델(gpt-6-luna 등)은 그대로 */
export function shortModelName(id: string | undefined): string {
  const s = id?.trim() ?? '';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/i.exec(s);
  if (!m) return s;
  const name = m[1]!;
  return `${name[0]!.toUpperCase()}${name.slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** 모델·추론 강도 한 줄: «Opus 5.5 · high» (없는 쪽은 빼요) */
export function modelEffortText(a: { model?: string; effort?: string }): string {
  return [shortModelName(a.model), a.effort?.trim()].filter(Boolean).join(' · ');
}
