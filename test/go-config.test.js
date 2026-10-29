import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readGoCachePaths } from '../src/go-config.js';
import { fixture } from './helpers.js';

test('Go paths honor environment, custom GOENV, and toolchain defaults without executing Go', async t => {
  const root = await fixture(t, {
    'toolchain/bin/go': 'not an executable',
    'toolchain/go.env': 'GOCACHE=/system/cache\nGOMODCACHE=/system/modules\n',
    'config/go/env': 'GOCACHE=/user/cache with spaces\nGOPATH=/user/work\n',
  });
  const binary = path.join(root, 'toolchain/bin/go');
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config') };
  let locations = await readGoCachePaths(binary, env);
  assert.equal(locations.GOCACHE, '/user/cache with spaces');
  assert.equal(locations.GOMODCACHE, '/system/modules');
  locations = await readGoCachePaths(binary, { ...env, GOCACHE: '/environment/cache', GOMODCACHE: '/environment/modules' });
  assert.equal(locations.GOCACHE, '/environment/cache');
  assert.equal(locations.GOMODCACHE, '/environment/modules');
  await writeFile(path.join(root, 'custom.env'), 'GOMODCACHE=/custom/modules\nGOCACHEPROG=/custom/program\n');
  locations = await readGoCachePaths(binary, { ...env, GOENV: path.join(root, 'custom.env') });
  assert.equal(locations.GOMODCACHE, '/custom/modules');
  assert.equal(locations.GOCACHEPROG, '/custom/program');
  assert.equal((await readGoCachePaths(binary, { ...env, GOENV: 'off' })).GOCACHE, '/system/cache');
});

test('Go Linux defaults and GOPATH first entry are resolved; no shell expansion', async t => {
  const root = await fixture(t, { 'bin/go': 'fixture' });
  const binary = path.join(root, 'bin/go');
  const locations = await readGoCachePaths(binary, { HOME: root, GOENV: 'off', XDG_CACHE_HOME: '/custom/cache', GOPATH: '/first:/second' });
  assert.equal(locations.GOCACHE, '/custom/cache/go-build');
  assert.equal(locations.GOMODCACHE, '/first/pkg/mod');
  assert.equal((await readGoCachePaths(binary, { HOME: root, GOENV: 'off' })).GOMODCACHE, path.join(root, 'go/pkg/mod'));
  await assert.rejects(readGoCachePaths(binary, { HOME: root, GOENV: 'relative' }), /absolute/);
});
