import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, symlink, writeFile, lstat } from 'node:fs/promises';
import { scanDirectory } from '../src/scanner.js';
import { planOrganization, organize, categoryFor } from '../src/organizer.js';
import { moveNoReplace } from '../src/move.js';
import { fixture, fakeUI } from './helpers.js';

test('maps every category and unknown extensions', () => {
  for (const [name, category] of Object.entries({ 'a.PDF': 'Documents', 'a.jpeg': 'Images', 'a.mp4': 'Videos', 'a.wav': 'Audio', 'a.tar.gz': 'Archives', 'setup.AppImage': 'Installers', '.hidden': 'Others', 'file.zz': 'Others' })) assert.equal(categoryFor(name), category);
});

test('moves top-level files safely with predictable collisions and preserves bytes', async t => {
  const root = await fixture(t, { 'note.txt': 'source', 'photo.png': 'image', 'Documents/note.txt': 'existing', 'Documents/note (1).txt': 'also existing', 'nested/project.txt': 'project' });
  const plan = await planOrganization(await scanDirectory(root, { recursive: true }));
  assert.equal(plan.operations.length, 2);
  assert.ok(plan.operations.find(op => op.file.name === 'note.txt').destination.endsWith('note (2).txt'));
  const result = await organize(plan, fakeUI(['y']));
  assert.equal(result.moved, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(await readFile(path.join(root, 'Documents/note.txt'), 'utf8'), 'existing');
  assert.equal(await readFile(path.join(root, 'Documents/note (2).txt'), 'utf8'), 'source');
  assert.equal(await readFile(path.join(root, 'nested/project.txt'), 'utf8'), 'project');
  assert.equal((await planOrganization(await scanDirectory(root, { recursive: true }))).operations.length, 0);
});

test('empty, dry-run, and refused organization do not create category directories', async t => {
  const empty = await fixture(t);
  assert.equal((await planOrganization(await scanDirectory(empty))).operations.length, 0);
  const root = await fixture(t, { 'a.pdf': 'a' });
  const plan = await planOrganization(await scanDirectory(root));
  await organize(plan, fakeUI([], false), { dryRun: true });
  await organize(plan, fakeUI(['']));
  assert.deepEqual(await readdir(root), ['a.pdf']);
  await assert.rejects(organize(plan, fakeUI([], false)), /interactive/);
});

test('symlink category directories are never traversed', async t => {
  const root = await fixture(t, { 'a.pdf': 'valuable', 'elsewhere/a.pdf': 'other' });
  await symlink(path.join(root, 'elsewhere'), path.join(root, 'Documents'));
  const plan = await planOrganization(await scanDirectory(root));
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.operations.length, 0);
});

test('no overwrite if a target appears after planning', async t => {
  const root = await fixture(t, { 'a.pdf': 'source', 'Documents/existing': 'x' });
  const plan = await planOrganization(await scanDirectory(root));
  await writeFile(path.join(root, 'Documents/a.pdf'), 'valuable');
  const result = await organize(plan, fakeUI(['yes']));
  assert.equal(result.moved, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(path.join(root, 'Documents/a.pdf'), 'utf8'), 'valuable');
  assert.equal(await readFile(path.join(root, 'a.pdf'), 'utf8'), 'source');
});

test('cross-device copy verifies destination before removing source', async t => {
  const root = await fixture(t, { source: 'some bytes' });
  const file = (await scanDirectory(root)).files[0];
  const target = path.join(root, 'destination');
  await moveNoReplace(file, target, { linkFile: async () => { throw Object.assign(new Error('Cross device'), { code: 'EXDEV' }); } });
  assert.equal(await readFile(target, 'utf8'), 'some bytes');
  await assert.rejects(lstat(file.path), { code: 'ENOENT' });
});

test('cross-device copy failure and failed unlink preserve originals', async t => {
  const root = await fixture(t, { source: 'valuable' });
  const file = (await scanDirectory(root)).files[0];
  const exdev = async () => { throw Object.assign(new Error('Cross device'), { code: 'EXDEV' }); };
  await assert.rejects(moveNoReplace(file, path.join(root, 'copy'), { linkFile: exdev, copy: async () => { throw new Error('Disk full'); } }), /Disk full/);
  assert.equal(await readFile(file.path, 'utf8'), 'valuable');
  await assert.rejects(moveNoReplace(file, path.join(root, 'linked'), { unlinkFile: async () => { throw new Error('Permission denied'); } }), /Destination retained/);
  assert.equal(await readFile(file.path, 'utf8'), 'valuable');
  assert.equal(await readFile(path.join(root, 'linked'), 'utf8'), 'valuable');
});

test('corrupt cross-device destination is detected before original removal', async t => {
  const root = await fixture(t, { source: 'valuable' });
  const file = (await scanDirectory(root)).files[0];
  await assert.rejects(moveNoReplace(file, path.join(root, 'corrupt'), {
    linkFile: async () => { throw Object.assign(new Error('Cross device'), { code: 'EXDEV' }); },
    copy: async (file, destination) => writeFile(destination, 'corrupt', { flag: 'wx' }),
  }), /verification failed/);
  assert.equal(await readFile(file.path, 'utf8'), 'valuable');
});

test('default organization shows category and collision counts, then a compact actual summary', async t => {
  const root = await fixture(t, { 'resume.pdf': 'resume', 'photo.png': 'image', 'Documents/resume.pdf': 'existing' });
  const ui = fakeUI(['y']);
  const result = await organize(await planOrganization(await scanDirectory(root)), ui);
  assert.equal(result.moved, 2);
  assert.match(ui.output.join('\n'), /Documents\s+1 file\s+->/);
  assert.match(ui.output.join('\n'), /Images\s+1 file\s+->/);
  assert.ok(ui.output.some(line => line.includes('Filename collisions: 1')));
  assert.ok(ui.output.some(line => line.includes('Organize 2 files into 2 folders? [y/N]')));
  assert.ok(ui.output.some(line => line.includes('Organized 2 files into 2 folders.')));
  assert.ok(ui.output.every(line => !line.includes('PLANNED MOVE:') && !line.startsWith('Organized:')));
  assert.equal(await readFile(path.join(root, 'Documents/resume (1).pdf'), 'utf8'), 'resume');
});

test('more than 1000 operations produce category-sized output and require approval before any move', async t => {
  const entries = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`photo-${i}.png`, 'image']));
  const root = await fixture(t, entries);
  const plan = await planOrganization(await scanDirectory(root));
  assert.equal(plan.operations.length, 1001);
  const declined = fakeUI(['']);
  await organize(plan, declined, { move: async () => assert.fail('Enter must not approve any move') });
  assert.equal((await readdir(root)).length, 1001);
  const ui = fakeUI(['yes']);
  let moved = 0;
  const result = await organize(plan, ui, { move: async () => { moved++; } });
  assert.equal(moved, 1001);
  assert.equal(result.moved, 1001);
  assert.match(ui.output.join('\n'), /Images\s+1001 files ->/);
  assert.ok(ui.output.some(line => line.includes('Organized 1001 files into 1 folder.')));
  assert.ok(ui.output.join('\n').split('\n').length < 15, 'Output must not grow with the number of successful operations');
});

test('verbose and dry-run list exact moves; only verbose execution lists individual successes', async t => {
  const root = await fixture(t, { 'photo.png': 'image' });
  const plan = await planOrganization(await scanDirectory(root));
  const preview = fakeUI([], false);
  await organize(plan, preview, { dryRun: true });
  assert.ok(preview.output.some(line => line.includes('PLANNED MOVE:') && line.includes('photo.png')));
  assert.deepEqual(await readdir(root), ['photo.png']);
  const verbose = fakeUI(['y']);
  await organize(plan, verbose, { verbose: true });
  assert.ok(verbose.output.some(line => line.includes('PLANNED MOVE:')));
  assert.ok(verbose.output.some(line => line.startsWith('Organized:')));
});

test('compact output still identifies failures and counts only completed folders', async t => {
  const root = await fixture(t, { 'photo.png': 'image', 'resume.pdf': 'resume' });
  const ui = fakeUI(['yes']);
  const result = await organize(await planOrganization(await scanDirectory(root)), ui, { move: async file => {
    if (file.name === 'resume.pdf') throw new Error('Permission denied');
  } });
  assert.equal(result.moved, 1);
  assert.equal(result.errors.length, 1);
  assert.ok(ui.output.some(line => line.includes('resume.pdf') && line.includes('Permission denied')));
  assert.ok(ui.output.some(line => line.includes('Organized 1 file into 1 folder.')));
});

test('collision planning reads each category once instead of probing every suffix', async t => {
  const entries = { 'photo.png': 'source', 'Images/photo.png': 'existing' };
  for (let i = 1; i <= 100; i++) entries[`Images/photo (${i}).png`] = 'existing';
  const root = await fixture(t, entries);
  let reads = 0;
  const plan = await planOrganization(await scanDirectory(root), { readDirectory: async directory => { reads++; return readdir(directory); } });
  assert.equal(reads, 1);
  assert.equal(plan.operations.length, 1);
  assert.ok(plan.operations[0].destination.endsWith('photo (101).png'));
  assert.equal(await readFile(path.join(root, 'Images/photo.png'), 'utf8'), 'existing');
});
