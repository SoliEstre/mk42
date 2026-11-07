// 설치 패키지의 업데이트 채널(계약 C4) — package.mjs 인자(build/scripts/update-channel.mjs), manifest.update 검사, 설치 기록·자격 증명 처리.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest, type PackageManifest } from '../src/setup/manifest.ts';
import { planUpdateRecord } from '../src/setup/plan.ts';
import { parseUpdateConfig } from '../src/updater.ts';
import { tempDir } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

interface UpdateChannelModule {
  DEFAULT_UPDATE_URL: string;
  resolveUpdateChannel(
    opts: { channel?: string; url?: string; authFile?: string },
    deps: { publicKeyFile: string; readFile?: (p: string) => Promise<string> },
  ): Promise<{ config: { channel: string; url: string; publicKey: string }; secret?: string } | undefined>;
  writePackageUpdate(dir: string, u: { config: { channel: string; url: string; publicKey: string }; secret?: string }): Promise<unknown>;
}
const uc = (await import(pathToFileURL(join(repo, 'build', 'scripts', 'update-channel.mjs')).href)) as UpdateChannelModule;
const PUB_FILE = join(repo, 'build', 'update-signing.pub.pem');

const H = 'a'.repeat(64);
function manifest(over: Partial<PackageManifest> = {}): PackageManifest {
  return {
    schema: 1,
    product: 'mark42',
    version: '2026.1105.143012',
    createdAt: '2026-11-05T14:30:12.000Z',
    source: { mark42Commit: 'abc1234', dirty: false, upstreamTag: '1.143.1' },
    appExe: 'Mk42.exe',
    components: [
      { name: 'runtime', version: '24.20.0', dir: 'runtime', treeHash: H, fileCount: 1, size: 1 },
      { name: 'daemon', version: '2026.1105.143012', dir: 'daemon', treeHash: H, fileCount: 4, size: 1 },
      { name: 'app', version: '1.143.1-e646868', dir: 'app', treeHash: H, fileCount: 9, size: 1 },
      { name: 'hub', version: '2026.1105.143012', dir: 'hub', treeHash: H, fileCount: 1, size: 1 },
      { name: 'extension', version: '0.1.13178646', dir: 'extension', treeHash: H, fileCount: 1, size: 1 },
    ],
    ...over,
  };
}

test('package update channel: the committed public key is Ed25519 and the default url is the internal server', async () => {
  const r = await uc.resolveUpdateChannel({ channel: 'internal' }, { publicKeyFile: PUB_FILE });
  assert.ok(r);
  assert.equal(r.config.url, 'https://mk42.estre.so/updates/');
  assert.equal(r.secret, undefined);
  assert.deepEqual(parseUpdateConfig(r.config), r.config, 'the engine accepts what the builder writes');
  assert.equal(await uc.resolveUpdateChannel({}, { publicKeyFile: PUB_FILE }), undefined, 'no flag → no channel');
});

test('package update channel: refuses bad combinations and never echoes the credential', async () => {
  const t = tempDir('mk42-pkg-update-');
  try {
    const auth = join(t.dir, 'auth.txt');
    writeFileSync(auth, '﻿mk42:very-secret-value\r\n');
    const ok = await uc.resolveUpdateChannel({ channel: 'internal', url: 'https://mk42.estre.so/updates', authFile: auth }, { publicKeyFile: PUB_FILE });
    assert.equal(ok?.secret, 'mk42:very-secret-value');
    assert.equal(ok?.config.url, 'https://mk42.estre.so/updates/');
    await assert.rejects(uc.resolveUpdateChannel({ channel: 'stable', authFile: auth }, { publicKeyFile: PUB_FILE }), /internal channel only/);
    await assert.rejects(uc.resolveUpdateChannel({ authFile: auth }, { publicKeyFile: PUB_FILE }), /need --update-channel/);
    await assert.rejects(uc.resolveUpdateChannel({ channel: 'beta' }, { publicKeyFile: PUB_FILE }), /must be one of/);
    await assert.rejects(uc.resolveUpdateChannel({ channel: 'internal', url: 'http://mk42.estre.so/updates/' }, { publicKeyFile: PUB_FILE }), /https/);
    await assert.rejects(uc.resolveUpdateChannel({ channel: 'internal', url: 'https://u:p@mk42.estre.so/' }, { publicKeyFile: PUB_FILE }), /credentials/);
    const rsa = join(t.dir, 'rsa.pem');
    writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString());
    await assert.rejects(uc.resolveUpdateChannel({ channel: 'internal' }, { publicKeyFile: rsa }), /Ed25519/);
    writeFileSync(auth, 'no-colon-very-secret-value');
    await assert.rejects(
      uc.resolveUpdateChannel({ channel: 'internal', authFile: auth }, { publicKeyFile: PUB_FILE }),
      (e: Error) => /user:password/.test(e.message) && !e.message.includes('very-secret-value'),
    );
  } finally {
    t.cleanup();
  }
});

test('package update channel: update.json/update.secret hashes in manifest.update are what the engine validates', async () => {
  const t = tempDir('mk42-pkg-update-');
  try {
    const r = await uc.resolveUpdateChannel({ channel: 'internal' }, { publicKeyFile: PUB_FILE });
    const update = (await uc.writePackageUpdate(t.dir, { ...r!, secret: 'mk42:tok' })) as PackageManifest['update'];
    const cfgText = readFileSync(join(t.dir, 'update.json'));
    assert.equal(update!.config.sha256, createHash('sha256').update(cfgText).digest('hex'));
    assert.equal(update!.config.size, cfgText.length);
    assert.equal(update!.secret!.sha256, createHash('sha256').update('mk42:tok').digest('hex'));
    assert.deepEqual(JSON.parse(cfgText.toString('utf8')), r!.config);
    assert.equal(validateManifest(manifest({ update })).update?.channel, 'internal');
    // 형식이 틀리면 거절
    const bad = [
      { ...update!, channel: 'Bad' },
      { ...update!, config: { ...update!.config, file: '../update.json' } },
      { ...update!, config: { ...update!.config, sha256: 'x' } },
      { ...update!, secret: { ...update!.secret!, file: 'auth.secret' } },
      { ...update!, secret: { ...update!.secret!, size: 5000 } },
    ];
    for (const b of bad) assert.throws(() => validateManifest(manifest({ update: b })), /invalid manifest\.json/, JSON.stringify(b));
    assert.equal(validateManifest(manifest()).update, undefined, 'packages without a channel stay valid');
  } finally {
    t.cleanup();
  }
});

test('planUpdateRecord: keep without a package channel; write/keep/remove the credential by channel', () => {
  const internal = { channel: 'internal', url: 'https://mk42.estre.so/updates/', publicKey: 'K' };
  const nulls = { channel: null, url: null, publicKey: null };
  assert.deepEqual(planUpdateRecord(undefined, undefined, false), { update: nulls, secret: 'keep' });
  assert.deepEqual(planUpdateRecord(internal, undefined, false), { update: internal, secret: 'keep' }, 'reinstall without update.json keeps the channel');
  assert.deepEqual(planUpdateRecord(nulls, internal, true), { update: internal, secret: 'write' });
  assert.deepEqual(planUpdateRecord(internal, internal, false), { update: internal, secret: 'keep' }, 'same channel, no new credential');
  const stable = { ...internal, channel: 'stable' };
  assert.deepEqual(planUpdateRecord(internal, stable, false), { update: stable, secret: 'remove' }, 'credential is not carried to another channel');
  const moved = { ...internal, url: 'https://other.example/updates/' };
  assert.equal(planUpdateRecord(internal, moved, false).secret, 'remove', 'credential is not sent to another server');
  assert.deepEqual(planUpdateRecord({ channel: 5 } as never, undefined, false).update, nulls, 'junk in the old record is dropped');
});
