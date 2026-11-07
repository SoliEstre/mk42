import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { folderIdFor, normalizePath, samePath } from '../src/paths.ts';

test('normalizePath on win32 strips long-path prefix, unifies separators, uppercases drive', () => {
  assert.equal(normalizePath('\\\\?\\c:\\Dev\\x\\', 'win32'), 'C:\\Dev\\x');
  assert.equal(normalizePath('c:/Dev/work area/Mark42', 'win32'), 'C:\\Dev\\work area\\Mark42');
  assert.equal(normalizePath('C:\\', 'win32'), 'C:\\');
});

test('samePath / folderIdFor ignore case on win32', () => {
  assert.ok(samePath('C:\\Dev\\A', 'c:\\dev\\a\\', 'win32'));
  assert.equal(folderIdFor('C:\\Dev\\A', 'win32'), folderIdFor('\\\\?\\c:\\dev\\a', 'win32'));
  assert.equal(folderIdFor('C:\\Dev\\A', 'win32').length, 16);
});
