// 번역 함수 꼴 — vscode.l10n.t와 같아요. lib/는 vscode에 기대지 않아서, 화면 글을 만드는 함수는 부르는 쪽에서 이걸 받아요.
// 원문(키)은 영어이고, 한국어는 extension/l10n/bundle.l10n.ko.json에 있어요.

export type Translate = (message: string, ...args: Array<string | number | boolean>) => string;

/** 원문 그대로({0}, {1}… 자리만 채워요) — 번역 함수를 넘기지 않았을 때·시험용 */
export const sourceText: Translate = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (whole, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : whole));
