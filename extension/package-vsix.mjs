// Mark42 확장 .vsix 묶기 — 새 의존성 없이 Node zlib로 ZIP을 써요(공개 배포하지 않는 개인용, AGENTS §5.12).
// 담는 것: package.json, dist/extension.cjs, dist/hub-ui.js·hub-ui.css(있으면), 언어 파일(package.nls*.json, l10n/*.json). 소스맵·소스·시험은 넣지 않아요.
// 사용: npm run package  →  extension/out/mark42-<버전>.vsix  (먼저 npm run build)
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** vsix 안의 경로 → 확장 폴더 기준 원본 경로. 없어도 되는 파일은 optional */
export const VSIX_FILES = [
  { path: 'extension/package.json', from: 'package.json' },
  { path: 'extension/dist/extension.cjs', from: 'dist/extension.cjs' },
  { path: 'extension/dist/hub-ui.js', from: 'dist/hub-ui.js', optional: true },
  { path: 'extension/dist/hub-ui.css', from: 'dist/hub-ui.css', optional: true },
  // 언어: package.json 기여 글(%키%)과 코드 글(vscode.l10n.t) 번들. l10n/ 안의 다른 *.json도 함께 담아요(listL10nFiles)
  { path: 'extension/package.nls.json', from: 'package.nls.json', optional: true },
  { path: 'extension/package.nls.ko.json', from: 'package.nls.ko.json', optional: true },
];

/** l10n/ 폴더의 언어 번들(bundle.l10n.<언어>.json 등 *.json) — 이름순 */
export async function listL10nFiles(root) {
  try {
    const names = (await readdir(join(root, 'l10n'), { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
    return names.sort().map((n) => ({ path: `extension/l10n/${n}`, from: `l10n/${n}` }));
  } catch {
    return [];
  }
}

/** package.json의 "%키%" 값을 package.nls.json(영어 기본) 글로 바꿔요 — 매니페스트 표시 이름·설명용 */
export function resolveNls(value, nls) {
  const m = typeof value === 'string' ? /^%([\w.-]+)%$/.exec(value) : null;
  return m && nls && typeof nls[m[1]] === 'string' ? nls[m[1]] : value;
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** extension.vsixmanifest — VS Code는 Identity·Engine·Manifest 자산을 봐요 */
export function buildManifest(pkg, nls) {
  pkg = { ...pkg, displayName: resolveNls(pkg.displayName, nls), description: resolveNls(pkg.description, nls) };
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(pkg.name)}" Version="${xmlEscape(pkg.version)}" Publisher="${xmlEscape(pkg.publisher)}" />
    <DisplayName>${xmlEscape(pkg.displayName ?? pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(pkg.description ?? '')}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(pkg.engines?.vscode ?? '*')}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

export const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".vsixmanifest" ContentType="text/xml" /><Default Extension=".cjs" ContentType="application/javascript" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".css" ContentType="text/css" /></Types>
`;

/** 작은 ZIP 작성기(deflate, UTF-8 이름, 고정 시각) — 같은 입력이면 같은 바이트 */
export function zip(entries) {
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01 00:00
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { path, data } of entries) {
    const name = Buffer.from(path, 'utf8');
    const body = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 빌드마다 다른 버전 — `<major>.<minor>.<2026-01-01부터 날짜 수 × 43200 + UTC 초÷2>` (HPP 빌드 번호와 같은 시계).
 * VS Code 확장 버전은 세 자리 semver라서 패치 자리에 넣어요. 같은 버전은 `--install-extension`이 다시 깔지 않아서 필요해요.
 */
export function stampVersion(base, now = new Date()) {
  const [major = '0', minor = '0'] = String(base).split('.');
  const days = Math.floor((now.getTime() - Date.UTC(2026, 0, 1)) / 86_400_000);
  const halfSeconds = Math.floor((now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 2);
  return `${major}.${minor}.${days * 43_200 + halfSeconds}`;
}

/**
 * root(확장 폴더)의 빌드 결과를 outDir에 mark42-<버전>.vsix로 써요. 경로를 돌려줘요.
 * vsix 안의 package.json·매니페스트에는 `version`(기본 {@link stampVersion})을 넣고, 원본 package.json은 고치지 않아요.
 */
export async function packageVsix(root, outDir = join(root, 'out'), { version } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  pkg.version = version ?? stampVersion(pkg.version);
  let nls;
  try {
    nls = JSON.parse(await readFile(join(root, 'package.nls.json'), 'utf8'));
  } catch {
    nls = undefined;
  }
  const entries = [
    { path: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { path: 'extension.vsixmanifest', data: Buffer.from(buildManifest(pkg, nls), 'utf8') },
  ];
  for (const f of [...VSIX_FILES, ...(await listL10nFiles(root))]) {
    const src = join(root, f.from);
    if (!(await exists(src))) {
      if (f.optional) continue;
      throw new Error(`${f.from} not found — run npm run build first`);
    }
    const data = f.from === 'package.json' ? Buffer.from(JSON.stringify(pkg, null, 2) + '\n', 'utf8') : await readFile(src);
    entries.push({ path: f.path, data });
  }
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `${pkg.name}-${pkg.version}.vsix`);
  await writeFile(file, zip(entries));
  return file;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = dirname(fileURLToPath(import.meta.url));
  const file = await packageVsix(root);
  console.log(`packaged ${file}`);
}
