import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, writeFile, unlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanDirectory } from '../src/scanner.js';
import { findDuplicates } from '../src/duplicates.js';
import { hashFile, mapLimit } from '../src/utils.js';
import { fixture } from './helpers.js';

test('groups identical bytes by size/hash across names and directories', async t => {
  const root = await fixture(t, { 'one/a': 'same', 'two/a': 'same', 'other': 'same', 'unequal': 'xxxx', 'small': 's', 'empty1': '', 'empty2': '' });
  const { files } = await scanDirectory(root, { recursive: true });
  const result = await findDuplicates(files);
  assert.deepEqual(result.groups.map(g => g.files.length).sort(), [2, 3]);
  assert.equal(result.potentialBytes, 8);
  assert.equal(result.redundantCopies, 3);
});

test('hard links and external aliases do not inflate storage estimates', async t => {
  const root = await fixture(t, { a: 'same', b: 'same', 'external/source': 'same' });
  await link(path.join(root, 'a'), path.join(root, 'alias'));
  let result = await findDuplicates((await scanDirectory(root)).files);
  assert.equal(result.redundantCopies, 1);
  assert.equal(result.potentialBytes, 4);
  await link(path.join(root, 'external/source'), path.join(root, 'outside-alias'));
  result = await findDuplicates((await scanDirectory(root)).files);
  assert.equal(result.potentialBytes, 8);
  const aliases = (await scanDirectory(root)).files.filter(f => ['a', 'alias'].includes(f.name));
  assert.equal((await findDuplicates(aliases)).potentialBytes, 0);
});

test('streams large files and detects changed files', async t => {
  const data = Buffer.alloc(12 * 1024 * 1024, 97);
  const root = await fixture(t, { large: data });
  const file = (await scanDirectory(root)).files[0];
  assert.equal(await hashFile(file), createHash('sha256').update(data).digest('hex'));
  await writeFile(file.path, 'changed');
  await assert.rejects(hashFile(file), /changed/);
});

test('hash failures remain uncertain and hashing concurrency is bounded', async t => {
  const root = await fixture(t, { a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' });
  let active = 0, peak = 0;
  const result = await findDuplicates((await scanDirectory(root)).files, { concurrency: 2, hash: async f => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (f.name === 'a') throw new Error('Unreadable');
    return 'hash';
  } });
  assert.equal(peak, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.groups[0].files.length, 4);
  await assert.rejects(mapLimit([], 0, () => {}));
});

test('hard-linked aliases share one hash while independent copies still require their own reads', async t => {
  const root = await fixture(t, { a: 'same', independent: 'same' });
  await link(path.join(root, 'a'), path.join(root, 'alias'));
  let reads = 0;
  const result = await findDuplicates((await scanDirectory(root)).files, { hash: async file => { reads++; return hashFile(file); } });
  assert.equal(reads, 2);
  assert.equal(result.groups[0].files.length, 3);
  assert.equal(result.potentialBytes, 4);
});

test('an alias replaced after representative hashing cannot inherit its digest', async t => {
  const root = await fixture(t, { a: 'same', 'outside/valuable': 'different' });
  await link(path.join(root, 'a'), path.join(root, 'alias'));
  const files = (await scanDirectory(root)).files;
  const result = await findDuplicates(files, { hash: async file => {
    const digest = await hashFile(file);
    await unlink(path.join(root, 'alias'));
    await symlink(path.join(root, 'outside/valuable'), path.join(root, 'alias'));
    return digest;
  } });
  assert.equal(result.groups.length, 0);
  assert.equal(result.hashes.get(path.join(root, 'alias')), null);
  assert.equal(result.errors.length, 1);
});
