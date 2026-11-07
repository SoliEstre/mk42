// 확장 폴더에서 에이전트 확장의 가장 높은 버전 찾기 — 데몬 extensions.ts newestInstalledVersion과 같은 규칙(시험용으로 vscode 없이).

/** 점으로 나눈 숫자 비교(시험판 꼬리는 무시) */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * `<id>-<버전>` 또는 `<id>-<버전>-<플랫폼>` 폴더 이름 중 가장 높은 버전. `obsolete`(확장 폴더의 `.obsolete` 키, 지워질 옛 버전)는 빼요.
 */
export function newestVersion(folderNames: readonly string[], obsolete: ReadonlySet<string>, id: string): string | undefined {
  const prefix = `${id.toLowerCase()}-`;
  let best: string | undefined;
  for (const raw of folderNames) {
    const n = raw.toLowerCase();
    if (!n.startsWith(prefix) || obsolete.has(n)) continue;
    const m = /^(\d+(?:\.\d+)*)(?:-[a-z0-9-]+)?$/.exec(n.slice(prefix.length));
    if (m && (!best || compareVersions(m[1]!, best) > 0)) best = m[1]!;
  }
  return best;
}
