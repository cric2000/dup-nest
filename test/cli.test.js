import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';

const entry = fileURLToPath(new URL('../bin/dupnest.js', import.meta.url));
const { version: packageVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30000, ...options });
  assert.ifError(result.error);
  return result;
}

test('real CLI help, version, argument errors and invalid directories', () => {
  const help = cli(['--help']).stdout;
  assert.match(help, /dupnest dev clean/);
  assert.match(help, /--verbose/);
  assert.equal(cli(['--version']).stdout.trim(), packageVersion);
  for (const args of [['invalid'], ['scan', '--force'], ['dev', 'scan', 'extra'], ['scan', '/nonexistent/dupnest-fixture']]) assert.equal(cli(args).status, 1);
});

test('scan and clean accept verbose while default scan summarizes results', async t => {
  const root = await fixture(t, { 'match-a.txt': 'same', 'match-b.txt': 'same' });
  const compact = cli(['scan', root]);
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /Exact duplicate groups: 1/);
  assert.doesNotMatch(compact.stdout, /match-a\.txt/);
  const verbose = cli(['scan', root, '--verbose']);
  assert.equal(verbose.status, 0, verbose.stderr);
  assert.match(verbose.stdout, /match-a\.txt/);
  const clean = cli(['clean', root, '--dry-run', '--verbose']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /match-a\.txt/);
});

test('all file dry-runs preserve unusual fixture files and reject piped mutation', async t => {
  const root = await fixture(t, { 'resume.pdf': 'same', 'resume (1).pdf': 'diff', '-$(name) Ω.pdf': 'same', 'nested/a.txt': 'nested' });
  await symlink(root, path.join(root, 'loop'));
  const before = (await readdir(root)).sort();
  for (const command of ['scan', 'clean', 'organize', 'tidy']) {
    const result = cli([command, root, '--recursive', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /resume/);
    assert.deepEqual((await readdir(root)).sort(), before);
  }
  assert.equal(await readFile(path.join(root, 'resume.pdf'), 'utf8'), 'same');
  for (const command of ['clean', 'organize', 'tidy', 'dev']) {
    const result = cli(command === 'dev' ? ['dev', 'clean'] : [command, root], { input: 'yes\n' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /interactive terminal/);
  }
});

test('developer dry-run inspects a configured fixture cache and never invokes maintenance', async t => {
  const root = await fixture(t, {
    'mock-bin/npm': '#!/usr/bin/env node\nif (process.argv.slice(2).join(" ") === "config get cache") process.stdout.write(process.env.DUPNEST_TEST_CACHE + "\\n"); else process.exit(87);\n',
    'cache/content': 'cached bytes',
  });
  await chmod(path.join(root, 'mock-bin/npm'), 0o755);
  const env = { ...process.env, PATH: path.join(root, 'mock-bin'), DUPNEST_TEST_CACHE: path.join(root, 'cache') };
  for (const command of ['scan', 'clean']) {
    const result = cli(['dev', command, '--dry-run'], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /npm cache/);
    assert.equal(await readFile(path.join(root, 'cache/content'), 'utf8'), 'cached bytes');
    assert.deepEqual(await readdir(path.join(root, 'cache')), ['content']);
  }
  const compact = cli(['dev', 'scan'], { env });
  assert.equal(compact.status, 0, compact.stderr);
  assert.match(compact.stdout, /Target\s+Cache used\s+Action/);
  assert.doesNotMatch(compact.stdout, /Path:|DUPNEST_PNPM_STORE_PATH/);
  assert.ok(compact.stdout.split('\n').length < 22);
  for (const args of [['dev', 'scan', '--verbose'], ['dev', 'clean', '--verbose', '--dry-run']]) {
    const detailed = cli(args, { env });
    assert.equal(detailed.status, 0, detailed.stderr);
    assert.ok(detailed.stdout.includes(`Path: "${path.join(root, 'cache')}"`));
    assert.equal(await readFile(path.join(root, 'cache/content'), 'utf8'), 'cached bytes');
  }
});

test('developer verbose requests scan-only measurements while default inspection skips those trees', async t => {
  const root = await fixture(t, { 'mock-bin/go': '#!/bin/sh\nexit 87\n', 'build/content': 'build cache', 'outside/valuable': 'preserved' });
  await chmod(path.join(root, 'mock-bin/go'), 0o755);
  await symlink(path.join(root, 'outside'), path.join(root, 'modules'));
  const env = { ...process.env, PATH: path.join(root, 'mock-bin'), GOENV: 'off', GOROOT: root, GOCACHE: path.join(root, 'build'), GOMODCACHE: path.join(root, 'modules'), GOCACHEPROG: '' };
  for (const command of ['scan', 'clean']) {
    const quick = cli(['dev', command, '--dry-run'], { env });
    assert.equal(quick.status, 0, quick.stderr);
    assert.match(quick.stdout, /Go module cache: scan only/);
    const full = cli(['dev', command, '--dry-run', '--verbose'], { env });
    assert.equal(full.status, 1, full.stderr);
    assert.match(full.stdout, /Inspection error:[\s\S]*symlinks are skipped/);
  }
  assert.equal(await readFile(path.join(root, 'outside/valuable'), 'utf8'), 'preserved');
  assert.equal(await readFile(path.join(root, 'build/content'), 'utf8'), 'build cache');
});
