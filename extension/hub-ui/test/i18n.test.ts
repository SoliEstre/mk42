import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, RpcError } from '@mark42/protocol';
import { detectLanguage, language, locale, MESSAGES, setLanguage, t } from '../src/i18n.ts';
import { describeError, formatDuration, formatRelativeTime, statusView, taskStatusView, tokenTooltip, windowCountTooltip } from '../src/model.ts';

test('detectLanguage: navigator.languages[0] → 없으면 navigator.language, ko로 시작하면 ko', () => {
  assert.equal(detectLanguage({ languages: ['ko-KR', 'en-US'] }), 'ko');
  assert.equal(detectLanguage({ languages: ['en-US', 'ko-KR'], language: 'ko-KR' }), 'en', 'first preferred language wins');
  assert.equal(detectLanguage({ languages: [], language: 'ko' }), 'ko');
  assert.equal(detectLanguage({ language: 'KO-kr' }), 'ko');
  assert.equal(detectLanguage({ language: 'ja-JP' }), 'en');
  assert.equal(detectLanguage({}), 'en');
});

test('setLanguage: 정하면 그 언어, undefined면 navigator로 다시 정해요', () => {
  setLanguage('en');
  assert.equal(language(), 'en');
  assert.equal(locale(), 'en-US');
  setLanguage('ko');
  assert.equal(language(), 'ko');
  assert.equal(locale(), 'ko-KR');
  setLanguage(undefined);
  assert.equal(language(), detectLanguage());
});

test('en·ko 사전은 키가 같고 빈 글이 없어요', () => {
  const en = Object.keys(MESSAGES.en).sort();
  const ko = Object.keys(MESSAGES.ko).sort();
  assert.deepEqual(ko, en);
  for (const lang of ['en', 'ko'] as const) {
    for (const [k, v] of Object.entries(MESSAGES[lang])) assert.ok(v.trim().length > 0, `${lang}.${k} empty`);
  }
  // 자리 표시({0}…)도 두 언어가 같아요
  const holes = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of en) assert.equal(holes(MESSAGES.ko[k as keyof typeof MESSAGES.ko]), holes(MESSAGES.en[k as keyof typeof MESSAGES.en]), k);
});

test('t: 자리 표시 채우기, 모자란 인수는 그대로', () => {
  setLanguage('ko');
  assert.equal(t('folders.matches', 3), '3개 일치');
  assert.equal(t('tasks.phaseTitle', '조사', 2, 1), '조사 — 시작 2 · 끝 1');
  assert.equal(t('clone.pickTitle'), '클론할 위치 — 이 폴더 아래에 «{0}» 폴더가 생겨요');
  setLanguage('en');
  assert.equal(t('folders.matches', 3), '3 matches');
  assert.equal(t('tasks.phaseTitle', 'Research', 2, 1), 'Research — started 2 · done 1');
});

test('영어 화면: 상대 시간·걸린 시간·상태·오류·툴팁', () => {
  setLanguage('en');
  const now = Date.parse('2026-11-05T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(formatRelativeTime(ago(10_000), now), 'just now');
  assert.equal(formatRelativeTime(ago(3 * 60_000), now), '3 min ago');
  assert.equal(formatRelativeTime(ago(26 * 3_600_000), now), 'yesterday');
  assert.equal(formatDuration(391_000), '6m 31s');
  assert.equal(formatDuration(26 * 3_600_000), '1d 2h');
  assert.equal(statusView('busy')?.label, 'Working');
  assert.equal(taskStatusView('done').label, 'Done');
  assert.equal(describeError(new RpcError(ErrorCode.InvalidPath, 'nope'), t('action.addFolder')), 'Add folder: The folder path does not exist or is not a folder (nope)');
  assert.equal(windowCountTooltip({ total: 1, byRole: { editor: 1 } }), 'Open windows: Editor 1');
  assert.equal(tokenTooltip({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 5000 }), 'Total tokens 5,000');
  setLanguage('ko');
  assert.equal(statusView('busy')?.label, '작업 중', 'labels follow the language at call time');
});
