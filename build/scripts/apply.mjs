// Mark42 패치 빌드 준비: 업스트림 작업 폴더(upstream.json workdir)가 고정한 커밋인지 확인하고, product.json에 overlay를 합치고,
// patches/*.patch를 적용하고, Mk42 아이콘을 넣어요. 몇 번 실행해도 같아요(이미 적용된 패치는 건너뜀).
//   node build/scripts/apply.mjs            적용
//   node build/scripts/apply.mjs --check    적용하지 않고 상태만
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readUpstream, upstreamWorkdir } from './paths.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, '..');
const repoRoot = join(buildDir, '..');
const upstream = readUpstream();
const work = upstreamWorkdir();
const check = process.argv.includes('--check');

function git(args, opts = {}) {
  return execFileSync('git', ['-C', work, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

const head = git(['rev-parse', 'HEAD']);
if (head !== upstream.commit) throw new Error(`${work} is at ${head}, expected ${upstream.tag} ${upstream.commit}`);
console.log(`upstream ${upstream.tag} ${head.slice(0, 10)} ok`);

// 1) patches
const patchDir = join(buildDir, 'patches');
for (const name of readdirSync(patchDir).filter((n) => n.endsWith('.patch')).sort()) {
  const file = join(patchDir, name);
  let applied = false;
  try {
    git(['apply', '--check', '--reverse', '--whitespace=nowarn', file]);
    applied = true;
  } catch {
    applied = false;
  }
  if (applied) {
    console.log(`patch ${name}: already applied`);
    continue;
  }
  if (check) {
    console.log(`patch ${name}: NOT applied`);
    continue;
  }
  git(['apply', '--whitespace=nowarn', file]);
  console.log(`patch ${name}: applied`);
}

// 2) product.json overlay — objects merge, null deletes, other values replace
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '//') continue;
    if (v === null) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}
const productFile = join(work, 'product.json');
const original = git(['show', `${upstream.commit}:product.json`]);
// 판 덧층(build/internal/product.overlay.json — 비공개 판에만 있어요)이 있으면 그 위에 한 번 더. '//' 키는 설명이라 빼요
const overlays = [join(buildDir, 'product.overlay.json'), join(buildDir, 'internal', 'product.overlay.json')].filter((f) => existsSync(f));
const merged = overlays.reduce((acc, f) => {
  const { '//': _note, ...over } = JSON.parse(readFileSync(f, 'utf8'));
  return merge(acc, over);
}, JSON.parse(original));
const text = JSON.stringify(merged, null, '\t') + '\n';
if (readFileSync(productFile, 'utf8').replace(/\r\n/g, '\n') === text) console.log('product.json: already merged');
else if (check) console.log('product.json: NOT merged');
else {
  writeFileSync(productFile, text);
  console.log(`product.json: merged (${merged.nameLong} / ${merged.nameShort}.exe, ${merged.dataFolderName}, ${merged.urlProtocol}://)`);
}

// 3) icons — the exe / taskbar icon is the Mk42 icon (multi-size .ico; was the window-pull client's until it became HPP, D50)
const icon = join(repoRoot, 'build', 'assets', 'mk42.ico');
const target = join(work, 'resources', 'win32', 'code.ico');
if (!existsSync(icon)) throw new Error(`icon not found: ${icon}`);
// 창 제목 표시줄 왼쪽 위 작은 아이콘(code-icon.svg)도 Mk42로. 빈 편집 영역 무늬(letterpress)는 OSS 일반 그림이라 그대로
for (const [from, to, label] of [
  [icon, target, 'code.ico'],
  [join(buildDir, 'resources', 'code-icon.svg'), join(work, 'src', 'vs', 'workbench', 'browser', 'media', 'code-icon.svg'), 'code-icon.svg'],
]) {
  if (readFileSync(from).equals(readFileSync(to))) console.log(`${label}: already Mk42`);
  else if (check) console.log(`${label}: NOT replaced`);
  else {
    copyFileSync(from, to);
    console.log(`${label}: Mk42`);
  }
}
