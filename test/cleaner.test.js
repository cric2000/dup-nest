import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, unlink, symlink, rename } from 'node:fs/promises';
import { scanDirectory } from '../src/scanner.js';
import { findDuplicates } from '../src/duplicates.js';
import { suggestCandidate } from '../src/versions.js';
import { cleanGroups, validateRename } from '../src/cleaner.js';
import { createTrash } from '../src/trash.js';
import { fixture, fakeUI } from './helpers.js';
import { hashFile } from '../src/utils.js';

async function setup(t, entries = { a: 'same', b: 'same' }) {
  const root = await fixture(t, entries);
  const duplicates = await findDuplicates((await scanDirectory(root)).files);
  const groups = duplicates.groups.map(g => ({ ...g, suggested: suggestCandidate(g.files) }));
  return { root, groups, hashes: duplicates.hashes };
}

test('selection and explicit approval trash only discarded files; optional rename is safe', async t => {
  const { root, groups, hashes } = await setup(t);
  const discarded = [];
  const ui = fakeUI(['1', 'retained', 'yes']);
  const result = await cleanGroups(groups, hashes, ui, { trashFactory: async () => async file => { discarded.push(file.name); await unlink(file.path); } });
  assert.deepEqual(discarded, ['b']);
  assert.equal(result.trashed, 1);
  assert.equal(result.renamed, 1);
  assert.equal(await readFile(path.join(root, 'retained'), 'utf8'), 'same');
  assert.equal(result.errors.length, 0);
});

test('keep all, skip, Enter and rejected confirmation never initialize Trash', async t => {
  const { groups, hashes } = await setup(t);
  for (const answers of [['a'], ['s'], [''], ['1', '', ''], ['1', '', 'no'], ['invalid', 's']]) {
    const result = await cleanGroups(groups, hashes, fakeUI(answers), { trashFactory: async () => { assert.fail('Trash must not run'); } });
    assert.equal(result.trashed, 0);
  }
});

test('dry-run and noninteractive execution cannot mutate', async t => {
  const { groups, hashes } = await setup(t);
  const never = async () => { assert.fail('No Trash in dry-run'); };
  assert.equal((await cleanGroups(groups, hashes, fakeUI([], false), { dryRun: true, trashFactory: never })).trashed, 0);
  await assert.rejects(cleanGroups(groups, hashes, fakeUI([], false), { trashFactory: never }), /interactive/);
  await assert.rejects(cleanGroups(groups, hashes, fakeUI([])), /unavailable/);
});

test('unavailable and failed Trash never fall back to deletion', async t => {
  const { root, groups, hashes } = await setup(t);
  const result = await cleanGroups(groups, hashes, fakeUI(['1', '', 'y']), { trashFactory: () => createTrash({ find: async () => null }) });
  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'same');
  const trash = await createTrash({ find: async () => '/mock/gio', run: async (command, args) => {
    assert.equal(command, '/mock/gio');
    assert.deepEqual(args, ['trash', '--', path.join(root, 'b')]);
    return { ok: false, stderr: 'not supported' };
  } });
  await assert.rejects(trash(groups[0].files[1]), /No permanent-deletion fallback/);
  assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'same');
});

test('rejects occupied rename destinations and invalid names', async t => {
  const { root, groups, hashes } = await setup(t, { a: 'same', b: 'same', occupied: 'valuable' });
  const result = await cleanGroups(groups, hashes, fakeUI(['1', 'occupied']));
  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(path.join(root, 'occupied'), 'utf8'), 'valuable');
  for (const name of ['..', '.', '../escape', '/absolute', 'x\0y']) assert.throws(() => validateRename(name));
});

test('changed files and symlink replacements abort the whole affected group', async t => {
  const { root, groups, hashes } = await setup(t);
  await writeFile(path.join(root, 'b'), 'different');
  let result = await cleanGroups(groups, hashes, fakeUI(['1', '', 'y']), { trashFactory: async () => { assert.fail('Changed group must not mutate'); } });
  assert.equal(result.errors.length, 1);
  await unlink(path.join(root, 'b'));
  await symlink(path.join(root, 'a'), path.join(root, 'b'));
  result = await cleanGroups(groups, hashes, fakeUI(['1', '', 'y']));
  assert.equal(result.trashed, 0);
});

test('directory replacement after scan is detected', async t => {
  const root = await fixture(t, { 'nested/a': 'same', 'nested/b': 'same', 'other/file': 'valuable' });
  const duplicates = await findDuplicates((await scanDirectory(path.join(root, 'nested'))).files);
  await rename(path.join(root, 'nested'), path.join(root, 'original'));
  await symlink(path.join(root, 'other'), path.join(root, 'nested'));
  const groups = duplicates.groups.map(g => ({ ...g, suggested: g.files[0] }));
  const result = await cleanGroups(groups, duplicates.hashes, fakeUI(['1', '', 'y']));
  assert.equal(result.trashed, 0);
  assert.equal(result.errors.length, 1);
});

test('partial operation failure reports exact completed count', async t => {
  const { root, groups, hashes } = await setup(t, { a: 'same', b: 'same', c: 'same' });
  let count = 0;
  const result = await cleanGroups(groups, hashes, fakeUI(['1', '', 'y']), { trashFactory: async () => async file => {
    if (++count === 2) throw new Error('Trash failed');
    await unlink(file.path);
  } });
  assert.equal(result.trashed, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(path.join(root, 'c'), 'utf8'), 'same');
});

test('successful gio must actually remove the source path', async t => {
  const { groups } = await setup(t);
  const trash = await createTrash({ find: async () => '/mock/gio', run: async () => ({ ok: true }) });
  await assert.rejects(trash(groups[0].files[1]), /still exists/);
});

test('interruption between approved operations stops further mutations and reports completion', async t => {
  const { groups, hashes } = await setup(t, { a: 'same', b: 'same', c: 'same' });
  const ui = fakeUI(['1', '', 'y']);
  let count = 0;
  const result = await cleanGroups(groups, hashes, ui, { trashFactory: async () => async file => {
    count++;
    await unlink(file.path);
    ui.cancelled = true;
  } });
  assert.equal(count, 1);
  assert.equal(result.trashed, 1);
  assert.equal(result.errors.length, 1);
  assert.ok(ui.output.some(line => line.includes('Group result: 1 file moved to Trash')));
});

test('approved groups hash every member once, retain exact previews, and summarize successful Trash moves', async t => {
  const { groups, hashes } = await setup(t, { a: 'same', b: 'same', c: 'same' });
  const read = [];
  const ui = fakeUI(['1', '', 'y']);
  const result = await cleanGroups(groups, hashes, ui, {
    hash: async file => { read.push(file.path); return hashFile(file); },
    trashFactory: async () => async file => unlink(file.path),
  });
  assert.equal(read.length, 3);
  assert.equal(new Set(read).size, 3);
  assert.equal(result.trashed, 2);
  assert.equal(ui.output.filter(line => line.startsWith('MOVE TO TRASH:')).length, 2);
  assert.equal(ui.output.filter(line => line.startsWith('Moved to Trash:')).length, 0);
  assert.ok(ui.output.some(line => line.includes('Group result: 2 files moved to Trash')));
});

test('metadata changes after group hashing stop subsequent approved operations', async t => {
  const { root, groups, hashes } = await setup(t, { a: 'same', b: 'same', c: 'same' });
  const result = await cleanGroups(groups, hashes, fakeUI(['1', '', 'yes']), { trashFactory: async () => async file => {
    await unlink(file.path);
    await writeFile(path.join(root, 'a'), 'changed');
  } });
  assert.equal(result.trashed, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(path.join(root, 'c'), 'utf8'), 'same');
});

test('verbose cleanup reports each completed Trash move', async t => {
  const { groups, hashes } = await setup(t);
  const ui = fakeUI(['1', '', 'y']);
  await cleanGroups(groups, hashes, ui, { verbose: true, trashFactory: async () => async file => unlink(file.path) });
  assert.equal(ui.output.filter(line => line.startsWith('Moved to Trash:')).length, 1);
});
