import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlink, lstat, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { scanDirectory } from '../src/scanner.js';
import { resolvePath } from '../src/utils.js';
import { fixture } from './helpers.js';

test('empty directory and path expansion', async t => {
  const root = await fixture(t);
  assert.equal((await scanDirectory(root)).files.length, 0);
  assert.equal(resolvePath('~/Downloads', root), path.join(root, 'Downloads'));
  assert.equal(resolvePath('~', root), root);
  assert.equal(resolvePath('.'), process.cwd());
  assert.throws(() => resolvePath('~someone'));
});

test('regular files, hidden files, temporary patterns, symlinks and recursion', async t => {
  const root = await fixture(t, { 'a.pdf': 'a', '.hidden': 'b', 'x.part': 'c', 'x.partial': '', 'x.download': '', 'x.CRDownload': '', 'sub/b': 'd' });
  await symlink(path.join(root, 'a.pdf'), path.join(root, 'link'));
  await symlink(root, path.join(root, 'sub', 'loop'));
  const flat = await scanDirectory(root);
  assert.deepEqual(flat.files.map(f => f.name), ['.hidden', 'a.pdf']);
  assert.equal(flat.files[1].extension, '.pdf');
  assert.equal(typeof flat.files[1].inode, 'number');
  const deep = await scanDirectory(root, { recursive: true });
  assert.equal(deep.files.length, 3);
  assert.equal(deep.skipped, 6);
  assert.equal(deep.complete, true);
});

test('invalid paths and symlink root are rejected', async t => {
  const root = await fixture(t, { file: 'x' });
  await assert.rejects(scanDirectory(path.join(root, 'missing')));
  await assert.rejects(scanDirectory(path.join(root, 'file')));
  await symlink(root, path.join(root, 'alias'));
  await assert.rejects(scanDirectory(path.join(root, 'alias')));
});

test('permission errors are reported and other directories remain scannable', async t => {
  const root = await fixture(t, { 'ok': 'x', 'blocked/file': 'y' });
  const result = await scanDirectory(root, { recursive: true, readDirectory: async p => {
    if ((await realpath(p)).endsWith('/blocked')) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return readdir(p);
  } });
  assert.equal(result.files.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].code, 'EACCES');
});

test('file scans use bounded metadata concurrency and preserve metadata for later revalidation', async t => {
  const root = await fixture(t, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`file-${i}.txt`, 'data'])));
  let active = 0, peak = 0;
  const scan = await scanDirectory(root, { concurrency: 4, lstatFile: async target => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await lstat(target); }
    finally { active--; }
  } });
  assert.equal(peak, 4);
  assert.equal(scan.files.length, 40);
  assert.equal(scan.complete, true);
  assert.equal(scan.files[0].parents.at(-1).path, root);
});

test('recursive file scans do not follow a child swapped to a symlink', async t => {
  const root = await fixture(t, { 'cache/child/file': 'data', 'outside/valuable': 'secret' });
  let changed = false;
  const scan = await scanDirectory(path.join(root, 'cache'), { recursive: true, lstatFile: async target => {
    const stat = await lstat(target);
    if (!changed && path.basename(target) === 'child') {
      changed = true;
      await rename(path.join(root, 'cache/child'), path.join(root, 'original'));
      await symlink(path.join(root, 'outside'), path.join(root, 'cache/child'));
    }
    return stat;
  } });
  assert.equal(scan.complete, false);
  assert.equal(scan.files.length, 0);
});

test('file scan depth limits report incomplete results rather than following unbounded trees', async t => {
  const root = await fixture(t, { 'nested/file': 'data' });
  const scan = await scanDirectory(root, { recursive: true, maxDepth: 0 });
  assert.equal(scan.complete, false);
  assert.match(scan.errors[0].message, /depth limit/);
});
