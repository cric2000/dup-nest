import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimes } from 'node:fs/promises';
import path from 'node:path';
import { scanDirectory } from '../src/scanner.js';
import { findDuplicates } from '../src/duplicates.js';
import { normalizeName, findVersions, buildReviewGroups } from '../src/versions.js';
import { fixture } from './helpers.js';

test('normalizes only trailing numbered suffixes', () => {
  assert.equal(normalizeName('resume (12).pdf'), 'resume.pdf');
  assert.equal(normalizeName('file (1)'), 'file');
  for (const name of ['report-2025.pdf', 'report-2026.pdf', 'file(2).pdf', 'file (1) notes.pdf', 'file (x).pdf']) assert.equal(normalizeName(name), name);
});

test('versions compare content and suggest timestamp rather than suffix', async t => {
  const root = await fixture(t, { 'resume.pdf': 'new', 'resume (1).pdf': 'old', 'resume (2).pdf': 'older', 'resume (3).doc': 'old', 'report-2025.pdf': 'y', 'report-2026.pdf': 'z', 'elsewhere/resume.pdf': 'new' });
  await utimes(path.join(root, 'resume.pdf'), 2000000000, 2000000000);
  const { files } = await scanDirectory(root, { recursive: true });
  const result = await findVersions(files);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].kind, 'versions');
  assert.equal(result.groups[0].suggested.name, 'resume.pdf');
});

test('exact copies, uncertain hashes, and overlapping families', async t => {
  const root = await fixture(t, { 'a.pdf': 'a', 'a (1).pdf': 'a', 'b.pdf': 'a', 'b (1).pdf': 'b' });
  const { files } = await scanDirectory(root);
  const duplicates = await findDuplicates(files);
  const versions = await findVersions(files, { hashes: duplicates.hashes });
  assert.equal(versions.groups.find(g => g.files.some(f => f.name === 'a.pdf')).kind, 'exact');
  const review = buildReviewGroups(duplicates.groups, versions.groups, versions.hashes);
  assert.equal(review.length, 1);
  assert.equal(review[0].files.length, 4);
  assert.equal(review[0].kind, 'versions');
  const unknown = await findVersions(files, { hash: async () => { throw new Error('Unavailable'); } });
  assert.ok(unknown.groups.every(g => g.kind === 'uncertain'));
});

test('large overlapping exact/version families merge without duplicate review entries', () => {
  const files = Array.from({ length: 4000 }, (_, i) => ({ path: `/fixture/file-${i}`, modifiedMs: i }));
  const hashes = new Map(files.map(file => [file.path, 'same-content']));
  const families = Array.from({ length: 2000 }, (_, i) => ({ files: files.slice(i * 2, i * 2 + 2) }));
  const groups = buildReviewGroups([{ files }], families, hashes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].files.length, 4000);
  assert.equal(new Set(groups[0].files.map(file => file.path)).size, 4000);
  assert.equal(groups[0].kind, 'exact');
  assert.equal(groups[0].suggested.path, '/fixture/file-3999');
});
