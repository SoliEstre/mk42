// 업스트림 작업 폴더(Code - OSS 소스) 정하기 — 한 곳에서. 순서: 환경 변수 MK42_UPSTREAM_DIR → build/internal/upstream.local.json(판 덧층)
// → build/upstream.json의 workdir(repo 루트 기준 상대 경로 가능, 기본 ../mk42-build/vscode). 빌드 결과·패키지는 그 부모 폴더에 생겨요.
// build.ps1·install.ps1은 같은 규칙을 PowerShell로 따라요.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readUpstream() {
  return JSON.parse(readFileSync(join(repoRoot, 'build', 'upstream.json'), 'utf8'));
}

export function upstreamWorkdir(env = process.env) {
  const local = join(repoRoot, 'build', 'internal', 'upstream.local.json');
  const dir = env.MK42_UPSTREAM_DIR || (existsSync(local) ? JSON.parse(readFileSync(local, 'utf8')).workdir : readUpstream().workdir);
  return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
}

/** 빌드 결과(VSCode-win32-x64)·패키지(dist)가 생기는 폴더 */
export function buildRoot(env = process.env) {
  return dirname(upstreamWorkdir(env));
}
