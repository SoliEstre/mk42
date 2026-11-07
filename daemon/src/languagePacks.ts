// C2(2026-11-05): CLI(`cli.js --install-extension`)로 깐 언어 팩은 `<userDataDir>\languagepacks.json`을 쓰지 않아요 — 그 파일은
// 창이 뜬 뒤 공유 프로세스의 NativeLanguagePackService(LanguagePacksCache)만 써요. 그런데 메인(mainImpl.ts → base/node/nls.ts
// resolveNLSConfiguration)은 시작할 때 그 파일을 읽어서, 없으면 argv.json locale이 ko여도 첫 창이 영어로 떠요.
// 그래서 데몬이 창을 띄우기 전에 LanguagePacksCache가 쓸 그대로 그 언어(languageId)의 항목을 써 둬요(Code-OSS 1.143.1에서 확인):
//  - 항목 = { hash, label, extensions: [{ extensionIdentifier: { id, uuid? }, version }], translations: { <id>: <절대 경로> } }
//  - label = localizedLanguageName ?? languageName, translations 경로 = join(확장 폴더, translation.path)
//  - id = `publisher.name` 소문자(getGalleryExtensionId), uuid = extensions.json 그 항목의 metadata.id(없으면 uuid를 빼요 — 스캐너와 같아요)
//  - hash = md5(각 확장마다 (uuid || id) 다음 version).hex — nls.ts가 `clp\<hash>.<언어>\<커밋>\nls.messages.json`을 첫 시작 때 만들어요
// 다른 언어 항목은 그대로 둬요. 공유 프로세스가 뜨면(LocalizationsUpdater) 설치된 확장으로 파일을 다시 만들어요 — hash가 같아서 다시 만들지 않아요.
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './extensions.ts';
import { atomicWriteFile } from './fsutil.ts';
import { errMsg, type Logger } from './log.ts';

export interface LanguagePackExtensionRef {
  extensionIdentifier: { id: string; uuid?: string };
  version: string;
}

/** languagepacks.json 한 언어 항목(LanguagePacksCache ILanguagePack) */
export interface LanguagePackEntry {
  hash: string;
  label: string | undefined;
  extensions: LanguagePackExtensionRef[];
  translations: Record<string, string>;
}

export type LanguagePacksFile = Record<string, LanguagePackEntry>;

export function languagePacksJsonPath(userDataDir: string): string {
  return join(userDataDir, 'languagepacks.json');
}

/** LanguagePacksCache.updateHash와 같아요 */
export function languagePackHash(extensions: readonly LanguagePackExtensionRef[]): string {
  const md5 = createHash('md5');
  for (const e of extensions) md5.update(e.extensionIdentifier.uuid || e.extensionIdentifier.id).update(e.version);
  return md5.digest('hex');
}

interface Translation {
  id: string;
  path: string;
}
interface Localization {
  languageId: string;
  languageName?: string;
  localizedLanguageName?: string;
  translations: Translation[];
}

/** languagePacks.ts isValidLocalization과 같아요 */
function isValidLocalization(l: unknown): l is Localization {
  if (!l || typeof l !== 'object') return false;
  const o = l as Record<string, unknown>;
  if (typeof o.languageId !== 'string') return false;
  if (!Array.isArray(o.translations) || o.translations.length === 0) return false;
  for (const t of o.translations as unknown[]) {
    const tr = t as Record<string, unknown> | null;
    if (!tr || typeof tr.id !== 'string' || typeof tr.path !== 'string') return false;
  }
  if (o.languageName && typeof o.languageName !== 'string') return false;
  if (o.localizedLanguageName && typeof o.localizedLanguageName !== 'string') return false;
  return true;
}

export interface InstalledExtension {
  /** 확장 폴더(절대 경로) */
  dir: string;
  /** extensions.json 그 항목의 metadata.id */
  uuid?: string;
}

interface StoredProfileExtension {
  identifier?: { id?: string; uuid?: string };
  version?: string;
  relativeLocation?: string;
  location?: string | { fsPath?: string; path?: string; scheme?: string };
  metadata?: { id?: string };
}

function storedLocation(extensionsDir: string, e: StoredProfileExtension): string | undefined {
  if (typeof e.relativeLocation === 'string' && e.relativeLocation) return join(extensionsDir, e.relativeLocation);
  const loc = e.location;
  if (!loc || typeof loc === 'string' || (loc.scheme && loc.scheme !== 'file')) return undefined; // 문자열 location은 VS Code도 무시해요
  if (loc.fsPath) return loc.fsPath;
  if (loc.path) {
    try {
      return fileURLToPath(`file://${loc.path}`);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readObsolete(extensionsDir: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fsp.readFile(join(extensionsDir, '.obsolete'), 'utf8')) as Record<string, unknown>;
    return new Set(Object.keys(raw).map((k) => k.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * 확장 폴더에 깔린 그 확장 — extensions.json(CLI 설치가 적어요)에서 가장 높은 버전, 거기 없으면 `<id>-<버전>[-<플랫폼>]` 폴더 중
 * 가장 높은 버전(uuid 없음). `.obsolete`(지운 확장) 폴더는 빼요.
 */
export async function findInstalledExtension(extensionsDir: string, id: string): Promise<InstalledExtension | undefined> {
  const want = id.toLowerCase();
  const obsolete = await readObsolete(extensionsDir);
  const isObsolete = (dir: string) => obsolete.has((dir.split(/[\\/]/).filter(Boolean).pop() ?? '').toLowerCase());
  let best: (InstalledExtension & { version: string }) | undefined;
  try {
    const list = JSON.parse(await fsp.readFile(join(extensionsDir, 'extensions.json'), 'utf8')) as unknown;
    if (Array.isArray(list)) {
      for (const e of list as StoredProfileExtension[]) {
        if (!e || e.identifier?.id?.toLowerCase() !== want) continue;
        const dir = storedLocation(extensionsDir, e);
        if (!dir || isObsolete(dir)) continue;
        const version = typeof e.version === 'string' ? e.version : '0';
        if (best && compareVersions(version, best.version) <= 0) continue;
        best = { dir, version, ...(typeof e.metadata?.id === 'string' && e.metadata.id ? { uuid: e.metadata.id } : {}) };
      }
    }
  } catch {
    // 없거나 깨졌으면 폴더에서 찾아요
  }
  if (best) return { dir: best.dir, ...(best.uuid ? { uuid: best.uuid } : {}) };
  let names: string[];
  try {
    names = (await fsp.readdir(extensionsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return undefined;
  }
  const prefix = `${want}-`;
  let pick: { name: string; version: string } | undefined;
  for (const name of names) {
    const n = name.toLowerCase();
    if (!n.startsWith(prefix) || obsolete.has(n)) continue;
    const m = /^(\d+(?:\.\d+)*)(?:-[a-z0-9-]+)?$/.exec(n.slice(prefix.length));
    if (m && (!pick || compareVersions(m[1]!, pick.version) > 0)) pick = { name, version: m[1]! };
  }
  return pick ? { dir: join(extensionsDir, pick.name) } : undefined;
}

/**
 * 깔린 확장 하나의 package.json contributes.localizations → 언어별 항목(LanguagePacksCache.createLanguagePacksFromExtension + updateHash).
 * 언어 기여가 없거나 manifest를 못 읽으면 빈 객체.
 */
export async function languagePackEntriesOf(ext: InstalledExtension): Promise<LanguagePacksFile> {
  let manifest: { publisher?: unknown; name?: unknown; version?: unknown; contributes?: { localizations?: unknown } };
  try {
    manifest = JSON.parse(await fsp.readFile(join(ext.dir, 'package.json'), 'utf8')) as typeof manifest;
  } catch {
    return {};
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return {};
  const publisher = typeof manifest.publisher === 'string' && manifest.publisher ? manifest.publisher : 'undefined_publisher';
  const id = `${publisher}.${manifest.name}`.toLowerCase();
  const extensionIdentifier = ext.uuid ? { id, uuid: ext.uuid } : { id };
  const localizations = Array.isArray(manifest.contributes?.localizations) ? (manifest.contributes.localizations as unknown[]) : [];
  const out: LanguagePacksFile = {};
  for (const l of localizations) {
    if (!isValidLocalization(l)) continue;
    let pack = out[l.languageId];
    if (!pack) {
      pack = { hash: '', label: l.localizedLanguageName ?? l.languageName, extensions: [{ extensionIdentifier, version: manifest.version }], translations: {} };
      out[l.languageId] = pack;
    }
    for (const t of l.translations) pack.translations[t.id] = join(ext.dir, t.path);
  }
  for (const pack of Object.values(out)) pack.hash = languagePackHash(pack.extensions);
  return out;
}

export type LanguagePacksResult = 'written' | 'kept' | 'no-pack';

/** 이미 있는 항목이 같은 확장·같은 버전이고 core(`vscode`) 번역 경로가 같으면 다시 쓰지 않아요(공유 프로세스가 만든 것도 그대로) */
function describesSame(cur: unknown, want: LanguagePackEntry): boolean {
  if (!cur || typeof cur !== 'object') return false;
  const c = cur as Partial<LanguagePackEntry>;
  if (typeof c.hash !== 'string' || !c.hash || !c.translations || typeof c.translations !== 'object' || !Array.isArray(c.extensions)) return false;
  const mine = want.extensions[0]!;
  const hit = c.extensions.some(
    (e) => e?.extensionIdentifier?.id?.toLowerCase() === mine.extensionIdentifier.id && e.version === mine.version,
  );
  // 공유 프로세스는 드라이브 문자를 소문자(c:\)로 써요 — 대소문자만 다르면 같은 경로(서로 덮어쓰기를 되풀이하지 않게)
  const curPath = c.translations['vscode'];
  return hit && typeof curPath === 'string' && curPath.toLowerCase() === want.translations['vscode']?.toLowerCase();
}

/**
 * C2: 깔린 언어 팩(`packId`)을 `<userDataDir>\languagepacks.json`에 적어요 — 그 팩의 언어 항목만 넣거나 바꾸고 다른 항목은 그대로(원자적 쓰기).
 * 팩이 없거나 언어 기여가 없으면 'no-pack', 이미 같으면 'kept'. 파일이 깨졌으면 VS Code처럼 빈 것으로 보고 새로 써요.
 */
export async function ensureLanguagePacksJson(
  userDataDir: string,
  extensionsDir: string,
  packId: string,
  log?: Logger,
): Promise<LanguagePacksResult> {
  const ext = await findInstalledExtension(extensionsDir, packId);
  if (!ext) return 'no-pack';
  const entries = await languagePackEntriesOf(ext);
  const langs = Object.keys(entries);
  if (langs.length === 0) {
    log?.warn(`language pack ${packId} at ${ext.dir} has no usable contributes.localizations`);
    return 'no-pack';
  }
  const file = languagePacksJsonPath(userDataDir);
  let cur: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) cur = raw as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  if (langs.every((l) => describesSame(cur[l], entries[l]!))) return 'kept';
  const next: Record<string, unknown> = { ...cur, ...entries };
  try {
    await atomicWriteFile(file, JSON.stringify(next));
  } catch (e) {
    log?.warn(`languagepacks.json not written (${errMsg(e)}): ${file}`);
    throw e;
  }
  log?.info(`languagepacks.json: ${langs.join(', ')} from ${packId} (${ext.dir}) → ${file}`);
  return 'written';
}

/** 경로가 절대 경로인지(시험용 도움) */
export const isAbsolutePath = isAbsolute;
