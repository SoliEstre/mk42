import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateSend, isSmokeRecord, smokeKey, smokePrompt, smokeRequestId, type SendGateInput } from '../src/lib/smoke.ts';
import { koT } from './helpers/l10n.ts';

const base: SendGateInput = { requested: true, settingEnabled: true, sender: 'osKeys', smoke: undefined, windowFocused: true };

test('smoke key is per extension id + version', () => {
  assert.equal(smokeKey('Anthropic.claude-code', '2.1.301'), 'mark42.smoke:anthropic.claude-code@2.1.301');
  assert.equal(smokeRequestId('openai.chatgpt', '26.1007.21434'), 'smoke:openai.chatgpt@26.1007.21434');
});

test('untested version sends; failed smoke falls back to fill-only', () => {
  assert.deepEqual(gateSend(base), { send: true, sender: 'osKeys' });
  assert.deepEqual(gateSend({ ...base, smoke: { ok: true, at: 'x', sender: 'osKeys' } }), { send: true, sender: 'osKeys' });
  assert.deepEqual(gateSend({ ...base, smoke: { ok: false, at: 'x', sender: 'osKeys' } }), { send: false, reason: 'smoke-failed' });
});

test('gate order: request, setting, sender, smoke, focus', () => {
  assert.deepEqual(gateSend({ ...base, requested: false }), { send: false, reason: 'not-requested' });
  assert.deepEqual(gateSend({ ...base, settingEnabled: false }), { send: false, reason: 'disabled' });
  assert.deepEqual(gateSend({ ...base, sender: 'none' }), { send: false, reason: 'sender-none' });
  assert.deepEqual(gateSend({ ...base, windowFocused: false }), { send: false, reason: 'not-focused' });
});

test('isSmokeRecord validates shape', () => {
  assert.equal(isSmokeRecord({ ok: true, at: '2026', sender: 'osKeys' }), true);
  assert.equal(isSmokeRecord({ ok: 'yes', at: '2026', sender: 'osKeys' }), false);
  assert.equal(isSmokeRecord(undefined), false);
  assert.match(smokePrompt('abc'), /\[m42-smoke-abc\]$/);
  assert.match(smokePrompt('abc', koT), /^Mark42 스모크 테스트예요\..* \[m42-smoke-abc\]$/);
});
