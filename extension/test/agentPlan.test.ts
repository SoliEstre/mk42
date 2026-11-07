import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSettingCommands, planAgentSteps } from '../src/lib/agentPlan.ts';
import { claudeOpenUri, codexConversationEditorUri, codexThreadUri } from '../src/lib/agentUris.ts';

test('claude settings map to slash commands', () => {
  assert.deepEqual(claudeSettingCommands({ effort: 'high' }, false), ['/effort high']);
  assert.deepEqual(claudeSettingCommands({ effort: 'high', ultracode: true }, false), ['/effort ultracode']);
  assert.deepEqual(claudeSettingCommands({ model: 'claude-opus-4-5', effort: 'max' }, false), ['/effort max']);
  assert.deepEqual(claudeSettingCommands({ model: 'claude-opus-4-5', effort: 'max' }, true), ['/model claude-opus-4-5', '/effort max']);
  assert.deepEqual(claudeSettingCommands({ effort: 'turbo; rm' as never, model: 'a b' }, true), []);
  assert.deepEqual(claudeSettingCommands(undefined, true), []);
});

test('send allowed: settings then prompt, all sent', () => {
  const p = planAgentSteps({ agent: 'claude', settings: { effort: 'xhigh' }, prompt: '재개해 주세요', newSession: false, sendAllowed: true });
  assert.deepEqual(p, {
    steps: [
      { text: '/effort xhigh', send: true, isSetting: true },
      { text: '재개해 주세요', send: true, isSetting: false },
    ],
    skipped: [],
  });
});

test('fill-only: prompt filled, settings skipped', () => {
  const p = planAgentSteps({ agent: 'claude', settings: { ultracode: true }, prompt: 'hi', newSession: false, sendAllowed: false });
  assert.deepEqual(p, { steps: [{ text: 'hi', send: false, isSetting: false }], skipped: ['/effort ultracode'] });
  assert.deepEqual(planAgentSteps({ agent: 'claude', prompt: '  ', newSession: true, sendAllowed: false }), { steps: [], skipped: [] });
});

test('codex settings are not typed into the panel', () => {
  const p = planAgentSteps({ agent: 'codex', settings: { model: 'gpt-5', reasoningEffort: 'high' }, prompt: 'go', newSession: false, sendAllowed: true });
  assert.deepEqual(p.steps, [{ text: 'go', send: true, isSetting: false }]);
});

test('agent URIs', () => {
  assert.equal(codexThreadUri('vscode', '019a-xyz'), 'vscode://openai.chatgpt/local/019a-xyz');
  assert.equal(codexConversationEditorUri('019a'), 'openai-codex://route/local/019a');
  assert.equal(claudeOpenUri('vscode'), 'vscode://anthropic.claude-code/open');
  assert.equal(
    claudeOpenUri('vscode', '0b6c4f7e-1111-2222-3333-444455556666', 'a b&c'),
    'vscode://anthropic.claude-code/open?session=0b6c4f7e-1111-2222-3333-444455556666&prompt=a+b%26c',
  );
  assert.throws(() => codexThreadUri('vscode', '../x'));
});
