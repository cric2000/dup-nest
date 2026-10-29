import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, findExecutable } from '../src/process.js';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.js';
import { readNpmCachePath } from '../src/npm-config.js';

test('process executor preserves literal arguments and reports launch failures', async () => {
  const value = '$(touch should-never-exist); spaces Unicode Ω --option';
  const result = await runProcess('/bin/echo', [value]);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, `${value}\n`);
  assert.equal((await runProcess('/nonexistent/dupnest-tool', [])).ok, false);
  assert.equal(await findExecutable('dupnest-uninstalled-test-tool', { PATH: '/usr/bin:/bin' }), null);
});

test('real npm cache discovery with logging disabled does not create a configured cache', async t => {
  const npm = await findExecutable('npm');
  assert.ok(npm);
  const root = await fixture(t);
  const cache = path.join(root, 'must-not-be-created');
  const result = await readNpmCachePath(npm, { env: { ...process.env, npm_config_cache: cache } });
  assert.equal(result.trim(), cache);
  await assert.rejects(lstat(cache), { code: 'ENOENT' });
});
