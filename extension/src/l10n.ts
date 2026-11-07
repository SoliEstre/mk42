// 화면 글 번역 — vscode.l10n.t를 lib/ 함수에 넘길 수 있는 꼴로 감싸요(언어 번들: l10n/bundle.l10n.<언어>.json).
import * as vscode from 'vscode';
import type { Translate } from './lib/l10n.ts';

export const t: Translate = (message, ...args) => vscode.l10n.t(message, ...args);
