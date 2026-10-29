import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { runCommand, printAnalysis } from '../src/workflows.js';
import { fixture, fakeUI } from './helpers.js';

test('tidy dry-run scans recursively without any mutations or category creation', async t => {
  const root = await fixture(t, { 'a.txt': 'same', 'a (1).txt': 'same', 'project/code.txt': 'code' });
  await symlink(root, path.join(root, 'link'));
  const before = await readdir(root);
  const ui = fakeUI([], false);
  assert.equal(await runCommand({ command: 'tidy', path: root, recursive: true, dryRun: true }, { ui }), 0);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'same');
  assert.ok(ui.output.some(line => line.includes('MOVE TO TRASH') || line.includes('move the other listed paths to Trash')));
  assert.ok(ui.output.some(line => line.includes('Files organized: 0')));
});

test('tidy phases have independent confirmations and refresh before organizing', async t => {
  const root = await fixture(t, { 'a.txt': 'same', 'b.txt': 'same' });
  // Decline duplicate review, preview organization, reject its final approval.
  const ui = fakeUI(['n', 'y', 'n']);
  assert.equal(await runCommand({ command: 'tidy', path: root }, { ui }), 0);
  assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'b.txt']);
  assert.ok(ui.output.some(line => line.includes('Organize 2 files into 1 folder?')));
});

test('file mutations refuse noninteractive execution before scanning', async () => {
  await assert.rejects(runCommand({ command: 'clean', path: '/nonexistent' }, { ui: fakeUI([], false) }), /interactive/);
});

test('organize and tidy forward verbose while default organization stays compact', async t => {
  for (const command of ['organize', 'tidy']) {
    const root = await fixture(t, { 'photo.png': 'image' });
    const ui = fakeUI(command === 'tidy' ? ['y', 'y'] : ['y']);
    assert.equal(await runCommand({ command, path: root, verbose: true }, { ui }), 0);
    assert.ok(ui.output.some(line => line.includes('PLANNED MOVE:')));
    assert.ok(ui.output.some(line => line.startsWith('Organized:')));
  }
  const root = await fixture(t, { 'photo.png': 'image' });
  const ui = fakeUI(['yes']);
  assert.equal(await runCommand({ command: 'organize', path: root }, { ui }), 0);
  assert.ok(ui.output.some(line => line.includes('Organized 1 file into 1 folder.')));
  assert.ok(ui.output.some(line => line.includes('Errors: 0')));
  assert.ok(ui.output.every(line => !line.startsWith('Organized:')));
});

test('scan summaries stay compact for large result sets, with every matching path available in verbose output', () => {
  const files = Array.from({ length: 1500 }, (_, i) => ({ path: `/fixture/copy-${i}.txt`, name: `copy-${i}.txt`, size: 4, modifiedAt: new Date(0) }));
  const group = { files, redundantCopies: 1499, potentialBytes: 5996 };
  const analysis = { scan: { root: '/fixture', files, skipped: 0 }, duplicates: { groups: [group], potentialBytes: 5996 }, versions: { groups: [] }, errors: [], groups: [group] };
  const compact = fakeUI([], false);
  printAnalysis(analysis, compact);
  assert.ok(compact.output.join('\n').split('\n').length < 18);
  assert.ok(compact.output.every(line => !line.includes('/fixture/copy-')));
  const verbose = fakeUI([], false);
  printAnalysis(analysis, verbose, { verbose: true });
  assert.equal(verbose.output.filter(line => line.includes('/fixture/copy-')).length, 1500);
});

test('clean dry-run reviews groups once instead of repeating the scan listing', async t => {
  const root = await fixture(t, { 'a.txt': 'same', 'b.txt': 'same' });
  const ui = fakeUI([], false);
  assert.equal(await runCommand({ command: 'clean', path: root, dryRun: true }, { ui }), 0);
  assert.ok(ui.output.every(line => !line.startsWith('\nExact duplicate group 1:')));
  assert.equal(ui.output.filter(line => line.includes('Exact duplicate copies (identical bytes)')).length, 1);
});
