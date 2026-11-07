import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Registry, REGISTRY_FILE } from '../src/registry.ts';
import { tempDir } from './helpers.ts';

test('registry: starts empty with defaults and persists atomically', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const reg = await Registry.load(dir);
    assert.deepEqual(reg.data.folders, []);
    assert.equal(reg.settings.resumeMode, undefined); // 판 기본값은 파일에 굳히지 않아요(edition.ts)
    assert.deepEqual(reg.settings.apps, []);
    await reg.update((d) => {
      d.folders.push({ id: 'a', path: 'C:\\x', label: 'x', addedAt: '2026-01-01T00:00:00.000Z' });
    });
    const onDisk = JSON.parse(readFileSync(join(dir, REGISTRY_FILE), 'utf8'));
    assert.equal(onDisk.schemaVersion, 1);
    assert.equal(onDisk.folders[0].id, 'a');
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
    const again = await Registry.load(dir);
    assert.equal(again.data.folders.length, 1);
  } finally {
    cleanup();
  }
});

test('registry: concurrent updates are serialized and all land', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const reg = await Registry.load(dir);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        reg.update((d) => {
          d.pinned.push({
            id: `p${i}`,
            folderPath: 'C:\\x',
            agent: 'claude',
            sessionId: `s${i}`,
            settings: {},
            resumePrompt: '',
            autoSend: true,
            enabled: true,
            order: i,
          });
        }),
      ),
    );
    await reg.flush();
    const onDisk = JSON.parse(readFileSync(join(dir, REGISTRY_FILE), 'utf8'));
    assert.equal(onDisk.pinned.length, 25);
  } finally {
    cleanup();
  }
});

test('registry: rename retries on EPERM/EBUSY', async () => {
  const { dir, cleanup } = tempDir();
  try {
    let failures = 2;
    let attempts = 0;
    const reg = await Registry.load(dir, {
      renameRetryDelayMs: 1,
      fs: {
        rename: async (a, b) => {
          attempts++;
          if (failures-- > 0) throw Object.assign(new Error('busy'), { code: failures % 2 ? 'EPERM' : 'EBUSY' });
          await fsp.rename(a, b);
        },
      },
    });
    await reg.update((d) => {
      d.settings.hubUiDir = 'C:\\ui';
    });
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(readFileSync(join(dir, REGISTRY_FILE), 'utf8')).settings.hubUiDir, 'C:\\ui');
  } finally {
    cleanup();
  }
});

test('registry: non-retryable rename error surfaces and removes tmp file', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const reg = await Registry.load(dir, {
      fs: {
        rename: async () => {
          throw Object.assign(new Error('nope'), { code: 'ENOSPC' });
        },
      },
    });
    await assert.rejects(reg.update((d) => void d.folders.push()), /nope/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  } finally {
    cleanup();
  }
});

test('registry: corrupt file is backed up and registry starts empty', async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, REGISTRY_FILE), '{ this is not json');
    const warnings: string[] = [];
    const log = {
      debug() {},
      info() {},
      warn: (m: string) => void warnings.push(m),
      error() {},
      child() {
        return log;
      },
    };
    const reg = await Registry.load(dir, { log, now: () => new Date('2026-10-17T01:02:03.004Z') });
    assert.deepEqual(reg.data.folders, []);
    const backup = join(dir, `${REGISTRY_FILE}.corrupt-2026-10-17T01-02-03-004Z`);
    assert.ok(existsSync(backup));
    assert.equal(readFileSync(backup, 'utf8'), '{ this is not json');
    assert.ok(!existsSync(join(dir, REGISTRY_FILE)));
    assert.equal(warnings.length, 1);
  } finally {
    cleanup();
  }
});

test('registry: wrong shape counts as corrupt; unknown keys are preserved otherwise', async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ schemaVersion: 1, folders: 'nope' }));
    const reg = await Registry.load(dir);
    assert.deepEqual(reg.data.folders, []);
    assert.equal(readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 1);

    const { dir: dir2, cleanup: c2 } = tempDir();
    try {
      writeFileSync(
        join(dir2, REGISTRY_FILE),
        '\uFEFF' + JSON.stringify({ schemaVersion: 1, extra: 42, settings: { resumeMode: 'console', custom: 'x' } }),
      );
      const r2 = await Registry.load(dir2);
      assert.equal(r2.settings.resumeMode, 'console'); // \uBA85\uC2DC\uD55C (a) \uCF58\uC194 \uC7AC\uAC1C\uB294 \uADF8\uB300\uB85C \uC9C0\uCF1C\uC694
      await r2.update(() => undefined);
      const onDisk = JSON.parse(readFileSync(join(dir2, REGISTRY_FILE), 'utf8'));
      assert.equal(onDisk.extra, 42);
      assert.equal(onDisk.settings.custom, 'x');
      assert.deepEqual(onDisk.slots, []);
    } finally {
      c2();
    }
  } finally {
    cleanup();
  }
});

test('registry: unsupported schemaVersion is treated as corrupt', async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ schemaVersion: 99 }));
    const reg = await Registry.load(dir);
    assert.equal(reg.data.schemaVersion, 1);
    assert.equal(readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 1);
  } finally {
    cleanup();
  }
});
