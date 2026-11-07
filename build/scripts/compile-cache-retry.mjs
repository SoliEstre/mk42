// 업스트림 빌드 마지막 단계(Node.js 컴파일 캐시 만들기)만 다시 해요 — 검사가 pty-host 캐시의 임시 파일(<해시>.<6자>)이
// 아직 쓰이는 중에 돌아 «unexpected pty-host cache entries»로 가끔 실패해요(두 번째 시도에 통과해요).
// 사용: node build/scripts/compile-cache-retry.mjs <업스트림 작업 폴더>   (build.ps1이 gulp 실패 때 불러요)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const work = process.argv[2];
if (!work) {
  console.error('usage: compile-cache-retry.mjs <workdir>');
  process.exit(2);
}
const lib = (name) => import(pathToFileURL(join(work, 'build', 'lib', name)).href);
const { generateNodeCompileCache } = await lib('nodeCompileCache.ts');
const { getVersionedResourcesFolder } = await lib('util.ts');
const { getVersion } = await lib('getVersion.ts');
const product = JSON.parse(readFileSync(join(work, 'product.json'), 'utf8'));
const out = join(dirname(work), 'VSCode-win32-x64');
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await generateNodeCompileCache('win32', out, getVersionedResourcesFolder('win32', getVersion(work)), product);
    console.log(`compile cache ok (attempt ${attempt})`);
    process.exit(0);
  } catch (e) {
    console.log(`compile cache attempt ${attempt} failed: ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(1);
