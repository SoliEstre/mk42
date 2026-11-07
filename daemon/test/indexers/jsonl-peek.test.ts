import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { peekJsonl } from '../../src/indexers/jsonl-peek.ts';
import { jsonl, makeTmp } from './helpers.ts';

const tmp = makeTmp('peek');
after(() => tmp.cleanup());

const pad = (n: number) => 'x'.repeat(n);

describe('peekJsonl', () => {
  it('reads a small file whole', async () => {
    const f = join(tmp.dir, 'small.jsonl');
    writeFileSync(f, jsonl([{ a: 1 }, { a: 2 }]) + 'not json\n{"a":3}');
    const r = await peekJsonl(f);
    assert.equal(r.whole, true);
    assert.deepEqual(r.head, [{ a: 1 }, { a: 2 }, { a: 3 }]);
    assert.deepEqual(r.tail, []);
  });

  it('reads only head and tail of a big file and never returns middle records', async () => {
    const f = join(tmp.dir, 'big.jsonl');
    const recs: unknown[] = [{ i: 'first' }];
    for (let i = 0; i < 400; i++) recs.push({ i, middle: true, p: pad(1000) });
    recs.push({ i: 'last' });
    writeFileSync(f, jsonl(recs));
    const r = await peekJsonl(f, { headBytes: 8 * 1024, tailBytes: 8 * 1024 });
    assert.equal(r.whole, false);
    assert.deepEqual(r.head[0], { i: 'first' });
    assert.deepEqual(r.tail.at(-1), { i: 'last' });
    assert.ok(r.head.length + r.tail.length < 30, 'only a few records read');
    // 잘린 줄은 버려요: 모든 레코드가 온전한 JSON
    for (const x of [...r.head, ...r.tail]) assert.equal(typeof x, 'object');
  });

  it('extends the head until headUntil is satisfied, skipping over-long lines', async () => {
    const f = join(tmp.dir, 'head.jsonl');
    const recs: unknown[] = [{ t: 'q' }, { t: 'huge', p: pad(300 * 1024) }];
    for (let i = 0; i < 50; i++) recs.push({ t: 'fill', p: pad(2000) });
    recs.push({ t: 'user', cwd: 'C:\\x' });
    for (let i = 0; i < 300; i++) recs.push({ t: 'fill2', p: pad(2000) });
    writeFileSync(f, jsonl(recs));
    const r = await peekJsonl(f, {
      headBytes: 16 * 1024,
      tailBytes: 16 * 1024,
      maxLineBytes: 64 * 1024,
      headUntil: (x) => typeof (x as { cwd?: unknown }).cwd === 'string',
    });
    assert.ok(r.head.some((x) => (x as { cwd?: string }).cwd === 'C:\\x'));
    assert.ok(!r.head.some((x) => (x as { t?: string }).t === 'huge'), 'over-long line skipped');
    assert.ok(r.head.filter((x) => (x as { t?: string }).t === 'fill2').length < 10, 'stopped soon after match');
  });

  it('widens the tail until tailUntil is satisfied', async () => {
    const f = join(tmp.dir, 'tail.jsonl');
    const recs: unknown[] = [{ t: 'h' }];
    for (let i = 0; i < 200; i++) recs.push({ t: 'fill', p: pad(1000) });
    recs.push({ t: 'assistant' });
    for (let i = 0; i < 40; i++) recs.push({ t: 'after', p: pad(1000) });
    writeFileSync(f, jsonl(recs));
    const want = (xs: unknown[]) => xs.some((x) => (x as { t?: string }).t === 'assistant');
    const narrow = await peekJsonl(f, { headBytes: 4096, tailBytes: 8 * 1024, maxTailBytes: 8 * 1024, tailUntil: want });
    assert.equal(want(narrow.tail), false);
    const wide = await peekJsonl(f, { headBytes: 4096, tailBytes: 8 * 1024, maxTailBytes: 512 * 1024, tailUntil: want });
    assert.equal(want(wide.tail), true);
  });

  it('keeps multi-byte UTF-8 intact across chunk boundaries', async () => {
    const f = join(tmp.dir, 'utf8.jsonl');
    const recs: unknown[] = [];
    for (let i = 0; i < 300; i++) recs.push({ i, s: '한글🙂'.repeat(50) });
    writeFileSync(f, jsonl(recs));
    const r = await peekJsonl(f, { headBytes: 4099, tailBytes: 4097 });
    for (const x of [...r.head, ...r.tail]) assert.equal((x as { s: string }).s, '한글🙂'.repeat(50));
  });
});
