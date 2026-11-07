import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHubTheme, syncHubTheme } from '../src/theme.ts';
import { FakeConnection, flush } from './fakes.ts';

function targets() {
  const props = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    style: { setProperty: (n: string, v: string) => void props.set(n, v), removeProperty: (n: string) => void props.delete(n) },
    dataset: {} as Record<string, string | undefined>,
  };
  const body = { classList: { add: (...t: string[]) => t.forEach((x) => classes.add(x)), remove: (...t: string[]) => t.forEach((x) => classes.delete(x)) } };
  return { props, classes, root, body };
}

test('theme: colors become the same --vscode-* variables a webview gets, kind sets the fallbacks and body classes', () => {
  const t = targets();
  applyHubTheme(t.root, t.body, { kind: 'dark', name: 'X', colors: { 'button.secondaryBackground': '#313131', 'editor.background': '#1F1F1F' } });
  assert.equal(t.props.get('--vscode-button-secondaryBackground'), '#313131');
  assert.equal(t.props.get('--vscode-editor-background'), '#1f1f1f');
  assert.equal(t.root.dataset.m42Kind, 'dark');
  assert.ok(t.classes.has('vscode-dark'));

  applyHubTheme(t.root, t.body, { kind: 'light', colors: { foreground: '#000000' } });
  assert.equal(t.props.get('--vscode-editor-background'), undefined, 'a color the new theme lacks is cleared');
  assert.ok(t.classes.has('vscode-light') && !t.classes.has('vscode-dark'));

  applyHubTheme(t.root, t.body, { kind: 'dark', colors: { foreground: 'red;background:url(x)', 'not.a.hub.color': '#ffffff' } });
  assert.equal(t.props.size, 0, 'only checked hex colors of the hub list reach CSS');

  applyHubTheme(t.root, t.body, null);
  assert.equal(t.root.dataset.m42Kind, undefined, 'no theme yet: follow the OS');
  assert.equal(t.classes.size, 0);
});

test('theme: loaded on connect and on state.changed {theme}; old daemons without theme.get are fine', async () => {
  const conn = new FakeConnection();
  conn.status = 'disconnected';
  let n = 0;
  conn.on('theme.get', () => ({ theme: { kind: 'dark', colors: { foreground: `#00000${++n}` } } }));
  const applied: unknown[] = [];
  const off = syncHubTheme(conn, (t) => applied.push(t));
  conn.setStatus('connected');
  await flush();
  assert.equal(applied.length, 1);
  conn.emitNotification('state.changed', { topics: ['pinned'] });
  await flush();
  assert.equal(applied.length, 1, 'other topics do not reload the theme');
  conn.emitNotification('state.changed', { topics: ['theme'] });
  await flush();
  assert.equal(applied.length, 2);
  off();

  const old = new FakeConnection(); // no theme.get handler: rejects
  const none: unknown[] = [];
  syncHubTheme(old, (t) => none.push(t));
  await flush();
  assert.equal(none.length, 0);
});
