// lib/ 시험용 번역 함수 — 한국어 언어 번들(l10n/bundle.l10n.ko.json)로 바꾸고 {0}… 자리를 채워요. 번들에 없으면 시험이 실패해요.
import { readFileSync } from 'node:fs';
import type { Translate } from '../../src/lib/l10n.ts';

export const KO_BUNDLE = JSON.parse(readFileSync(new URL('../../l10n/bundle.l10n.ko.json', import.meta.url), 'utf8')) as Record<string, string>;

export const koT: Translate = (message, ...args) => {
  if (!Object.hasOwn(KO_BUNDLE, message)) throw new Error(`not in the ko bundle: ${message}`);
  return KO_BUNDLE[message]!.replace(/\{(\d+)\}/g, (whole, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : whole));
};
