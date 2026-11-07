// Mark42 확장 번들: src/extension.ts → dist/extension.cjs (확장 호스트용 CJS)
// hub-ui가 있으면 hub-ui/src/main.ts → dist/hub-ui.js (브라우저 IIFE), hub-ui.css 복사. 없으면 건너뛰어요.
import { build } from 'esbuild';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const minify = process.argv.includes('--minify');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'extension.ts')],
  outfile: join(dist, 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  minify,
  logLevel: 'info',
});

const hubMain = join(root, 'hub-ui', 'src', 'main.ts');
if (await exists(hubMain)) {
  await build({
    entryPoints: [hubMain],
    outfile: join(dist, 'hub-ui.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    minify,
    logLevel: 'info',
  });
  const css = join(root, 'hub-ui', 'src', 'hub-ui.css');
  if (await exists(css)) await copyFile(css, join(dist, 'hub-ui.css'));
} else {
  console.log('hub-ui not found — skipped hub-ui bundle');
}
