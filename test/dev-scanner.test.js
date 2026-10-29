import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { link, symlink, lstat, readdir, realpath, rename } from 'node:fs/promises';
import { scanDeveloperStorage, parseDockerUsage, parseDockerDaemonId, dockerReportsZeroReclaimable, countDockerDanglingImages, measureDirectory, printDeveloperStorage } from '../src/dev-scanner.js';
import { fixture, fakeUI } from './helpers.js';

test('missing tools are normal and no child processes run', async () => {
  const report = await scanDeveloperStorage({ find: async () => null, run: async () => assert.fail('No installed tools') });
  assert.equal(report.errors.length, 0);
  assert.ok(Object.values(report.tools).every(tool => tool.status === 'Not found'));
});

test('configured paths and Docker structured data are inspected without initializing caches', async () => {
  const calls = [];
  const usage = { allocatedBytes: 1000, logicalBytes: 1000, complete: true, errors: [] };
  const run = async (executable, args) => {
    calls.push([executable, args]);
    const command = [path.basename(executable), ...args].join(' ');
    const outputs = {
      'docker info --format {{json .ID}}': '"daemon-id"',
      'docker system df --format {{json .}}': '{"Type":"Images","Size":"1GB","Reclaimable":"500MB (50%)"}\n{"Type":"Local Volumes","Size":"2GB","Reclaimable":"0B"}',
      'docker image ls --filter dangling=true --no-trunc --format {{json .ID}}': '',
    };
    assert.ok(command in outputs, `Unexpected command: ${command}`);
    return { ok: true, stdout: outputs[command], stderr: '' };
  };
  const measured = [];
  const report = await scanDeveloperStorage({ verbose: true, find: async name => `/mock/${name}`, run, npmPath: async () => '/custom/npm cache', goPaths: async () => ({ GOCACHE: '/custom/go build', GOMODCACHE: '/custom/modules' }), env: { GRADLE_USER_HOME: '/custom/gradle', DUPNEST_PNPM_STORE_PATH: '/custom/pnpm', DUPNEST_YARN_CACHE_PATH: '/custom/yarn' }, measure: async p => { measured.push(p); return usage; } });
  assert.equal(report.errors.length, 0);
  assert.deepEqual(measured.sort(), ['/custom/npm cache', '/custom/go build', '/custom/modules', '/custom/pnpm', '/custom/yarn', '/custom/gradle/caches'].sort());
  assert.equal(report.docker.length, 2);
  assert.equal(report.dockerDaemon, 'daemon-id');
  assert.equal(report.dockerDanglingImages, 0);
  assert.ok(calls.every(([cmd, args]) => !args.includes('prune') && !args.includes('clean') && !args.includes('verify') && !['go', 'gradle', 'yarn', 'pnpm'].some(name => cmd.endsWith(`/${name}`))));
});

test('Docker failure and malformed output are reported', async () => {
  assert.throws(() => parseDockerUsage('human readable table'));
  assert.throws(() => parseDockerUsage('[]'));
  const report = await scanDeveloperStorage({ find: async name => name === 'docker' ? '/mock/docker' : null, run: async () => ({ ok: false, stderr: 'Permission denied' }) });
  assert.equal(report.errors.length, 1);
  assert.match(report.tools.docker.status, /unavailable/);
});

test('Gradle unknown home is advisory, and invalid tool paths are not guessed', async () => {
  const report = await scanDeveloperStorage({ find: async name => ['gradle', 'npm'].includes(name) ? `/mock/${name}` : null, env: {}, npmPath: async () => 'relative/path' });
  assert.equal(report.caches.find(c => c.id === 'gradle').available, false);
  assert.equal(report.caches.find(c => c.id === 'npm').path, null);
  assert.equal(report.errors.length, 1);
});

test('measurement ignores symlinks, counts hard links once, and reports bounds', async t => {
  const root = await fixture(t, { file: 'data', 'sub/another': 'other' });
  await link(path.join(root, 'file'), path.join(root, 'alias'));
  await symlink(root, path.join(root, 'sub/loop'));
  const usage = await measureDirectory(root);
  assert.equal(usage.logicalBytes, 9);
  assert.equal(usage.complete, true);
  assert.equal((await measureDirectory(root, { maxEntries: 1 })).allocatedBytes, null);
  assert.equal((await measureDirectory(path.join(root, 'absent'))).allocatedBytes, 0);
});

test('metadata reads run in bounded parallel batches without per-file ancestor lookups', async t => {
  const root = await fixture(t, Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`file-${i}`, 'data'])));
  let active = 0, peak = 0, calls = 0;
  const usage = await measureDirectory(root, { concurrency: 4, lstatFile: async target => {
    calls++; active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await lstat(target); }
    finally { active--; }
  } });
  assert.equal(usage.complete, true);
  assert.equal(usage.logicalBytes, 256);
  assert.equal(calls, 64);
  assert.equal(peak, 4);
  assert.equal((await readdir(root)).length, 64);
});

test('permission failures and recursion limits are reported as unknown measurements', async t => {
  const root = await fixture(t, { file: 'data', 'blocked/file': 'other' });
  const usage = await measureDirectory(root, { readDirectory: async anchored => {
    if ((await realpath(anchored)).endsWith('/blocked')) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return readdir(anchored);
  } });
  assert.equal(usage.complete, false);
  assert.equal(usage.allocatedBytes, null);
  assert.equal(usage.errors[0].path, path.join(root, 'blocked'));
  assert.equal(usage.errors[0].code, 'EACCES');
  const limited = await measureDirectory(root, { maxDepth: 0 });
  assert.equal(limited.complete, false);
  assert.match(limited.errors[0].message, /depth limit/);
  await assert.rejects(measureDirectory(root, { concurrency: 0 }), /concurrency/);
  await assert.rejects(measureDirectory(root, { concurrency: 33 }), /concurrency/);
});

test('a child replaced by a symlink is never opened or followed', async t => {
  const root = await fixture(t, { 'cache/child/file': 'data', 'outside/valuable': 'must not inspect' });
  let replaced = false;
  const visited = [];
  const usage = await measureDirectory(path.join(root, 'cache'), {
    readDirectory: async anchored => { visited.push(await realpath(anchored)); return readdir(anchored); },
    lstatFile: async target => {
      const stat = await lstat(target);
      if (!replaced && path.basename(target) === 'child') {
        replaced = true;
        await rename(path.join(root, 'cache/child'), path.join(root, 'original'));
        await symlink(path.join(root, 'outside'), path.join(root, 'cache/child'));
      }
      return stat;
    },
  });
  assert.equal(usage.complete, false);
  assert.equal(usage.logicalBytes, null);
  assert.ok(visited.every(directory => !directory.includes('/outside')));
  assert.equal(visited.length, 1);
});

test('pinned directory handles resist root replacement and report the changed path', async t => {
  const root = await fixture(t, { 'cache/file': 'data', 'outside/valuable': 'must not inspect' });
  let replaced = false;
  const usage = await measureDirectory(path.join(root, 'cache'), { readDirectory: async anchored => {
    const names = await readdir(anchored);
    if (!replaced) {
      replaced = true;
      await rename(path.join(root, 'cache'), path.join(root, 'original'));
      await symlink(path.join(root, 'outside'), path.join(root, 'cache'));
    }
    return names;
  } });
  assert.equal(usage.complete, false);
  assert.equal(usage.allocatedBytes, null);
  assert.ok(usage.errors.some(error => error.message.includes('Directory changed')));
});

function storageReport() {
  return {
    tools: Object.fromEntries(['docker', 'npm', 'go', 'pnpm', 'yarn', 'gradle'].map(name => [name, { executable: name === 'gradle' ? null : `/mock/${name}`, status: name === 'gradle' ? 'Not found' : 'Installed' }])),
    dockerDaemon: 'daemon-id',
    docker: [{ type: 'Images', usage: '3.041GB', reclaimable: '305MB (10%)' }, { type: 'Local Volumes', usage: '0B', reclaimable: '0B' }],
    caches: [
      { id: 'npm', label: 'npm cache', path: '/configured/npm', usage: { allocatedBytes: 1024, complete: true }, available: true, advisory: 'Supported: verify before clearing.' },
      { id: 'go-build', label: 'Go build cache', path: '/configured/build', usage: { allocatedBytes: 2048, complete: true }, available: true, advisory: 'Supported: go clean -cache.' },
      { id: 'go-modules', label: 'Go module cache', path: '/configured/modules', usage: { allocatedBytes: 4096, complete: true }, available: true, advisory: 'Scan-only in V1.' },
      { id: 'pnpm', label: 'pnpm store', warning: 'Set DUPNEST_PNPM_STORE_PATH to inspect.', advisory: 'Scan-only in V1.' },
      { id: 'yarn', label: 'Yarn cache', warning: 'Set DUPNEST_YARN_CACHE_PATH to inspect.', advisory: 'Scan-only in V1.' },
    ], errors: [],
  };
}

test('default developer report leads with actionable targets and explicitly separates retained storage', () => {
  const report = storageReport();
  const ui = fakeUI([], false);
  printDeveloperStorage(report, ui);
  const output = ui.output.join('\n');
  assert.match(output, /Target\s+Cache used\s+Action/);
  assert.match(output, /npm cache\s+1\.0 KiB\s+Verify; full clear optional/);
  assert.match(output, /Go build cache\s+2\.0 KiB\s+Clear build cache/);
  assert.match(output, /Docker dangling images\s+Unknown\s+Prune dangling only/);
  assert.match(output, /Not cleaned by these actions:[\s\S]*Go module cache, pnpm store, Yarn cache: scan only/);
  assert.doesNotMatch(output, /3\.041GB|4\.0 KiB|Not found|Available/);
  assert.doesNotMatch(output, /\/configured\/|305MB|DUPNEST_PNPM_STORE_PATH/);
  assert.match(output, /current usage, not expected savings/);
  assert.match(output, /verification keeps valid packages/);
  assert.ok(output.split('\n').length < 22);
});

test('verbose developer report includes paths, tool status, reclaimable estimates and advisory details', () => {
  const report = storageReport();
  const ui = fakeUI([], false);
  printDeveloperStorage(report, ui, { verbose: true });
  const output = ui.output.join('\n');
  assert.match(output, /docker\s+Installed/);
  assert.match(output, /Path: "\/configured\/npm"/);
  assert.match(output, /305MB \(10%\)/);
  assert.match(output, /DUPNEST_PNPM_STORE_PATH/);
  assert.match(output, /Potential reclaimable total: unknown/);
});

test('compact developer errors stay visible without flooding output; verbose retains every reason', () => {
  const report = storageReport();
  report.caches[0].usage = { complete: false, allocatedBytes: null };
  report.errors = Array.from({ length: 1000 }, () => ({ path: '/configured/npm/file', message: 'Permission denied' }));
  const ui = fakeUI([], false);
  printDeveloperStorage(report, ui);
  assert.match(ui.output.join('\n'), /npm cache: cleanup unavailable/);
  assert.match(ui.output.join('\n'), /Inspection incomplete: 1000 error/);
  assert.ok(ui.output.join('\n').split('\n').length < 24);
  const verbose = fakeUI([], false);
  printDeveloperStorage(report, verbose, { verbose: true });
  assert.equal(verbose.output.filter(line => line.startsWith('Inspection error:')).length, 1000);
  assert.match(verbose.output.join('\n'), /Permission denied/);
});

test('Docker JSON identities are decoded and malformed identities are refused', () => {
  assert.equal(parseDockerDaemonId(' "daemon-id"\n'), 'daemon-id');
  for (const output of ['', 'null', '{}', '123', '""', '"  "', '"bad\\nID"']) assert.throws(() => parseDockerDaemonId(output));
});

test('Docker counts preserve known emptiness without treating missing or invalid values as zero', () => {
  for (const count of ['0', 0, '1', undefined, null, '', -1, 'unknown']) {
    const [row] = parseDockerUsage(JSON.stringify({ Type: 'Containers', Size: '0B', Reclaimable: '0B', TotalCount: count }));
    assert.equal(row.totalCount, count === '0' || count === 0 ? 0 : count === '1' ? 1 : null);
  }
  for (const value of ['0B', '0 B', '0.0B (0%)']) assert.equal(dockerReportsZeroReclaimable({ reclaimable: value }), true);
  for (const value of ['10B', '0.1B', 'unknown', undefined]) assert.equal(dockerReportsZeroReclaimable({ reclaimable: value }), false);
});

test('developer cleanup report shows known Docker no-ops and omits the self-referential hint', () => {
  const report = storageReport();
  report.docker.push({ type: 'Build Cache', usage: '561.9MB', reclaimable: '0B' }, { type: 'Containers', usage: '0B', totalCount: 0 });
  const ui = fakeUI([], false);
  printDeveloperStorage(report, ui, { command: 'dev clean' });
  assert.match(ui.output.join('\n'), /Not cleaned by these actions:[\s\S]*Docker build cache: 561\.9MB retained; Docker reports 0 B reclaimable/);
  assert.doesNotMatch(ui.output.join('\n'), /Docker containers\s+Unknown/);
  assert.doesNotMatch(ui.output.join('\n'), /Run dupnest dev clean/);
});

test('dangling image counts deduplicate full IDs and reject malformed results', () => {
  const id = 'a'.repeat(64);
  assert.equal(countDockerDanglingImages(''), 0);
  assert.equal(countDockerDanglingImages(`"sha256:${id}"\n"${id}"\n`), 1);
  for (const output of ['invalid', 'null', '{}', '""', '"truncated-id"']) assert.throws(() => countDockerDanglingImages(output));
});

test('image inspection failure preserves usage and unknown count rather than claiming no dangling images', async () => {
  const report = await scanDeveloperStorage({ find: async name => name === 'docker' ? '/mock/docker' : null,
    run: async (cmd, args) => args[0] === 'info' ? { ok: true, stdout: '"daemon-id"' } : args[0] === 'system' ?
      { ok: true, stdout: '{"Type":"Images","Size":"2GB","Reclaimable":"1GB"}' } : { ok: false, stderr: 'image inspection failed' } });
  assert.equal(report.docker.length, 1);
  assert.equal(report.dockerDanglingImages, null);
  assert.equal(report.errors.length, 1);
  const ui = fakeUI([], false);
  printDeveloperStorage(report, ui);
  assert.doesNotMatch(ui.output.join('\n'), /No dangling images/);
});

test('total image storage is never shown as the size of a supported dangling-image cleanup', () => {
  for (const count of [0, 3]) {
    const report = { ...storageReport(), dockerDanglingImages: count };
    const ui = fakeUI([], false);
    printDeveloperStorage(report, ui);
    const output = ui.output.join('\n');
    const actionable = output.split('Not cleaned by these actions:')[0];
    assert.doesNotMatch(actionable, /3\.041GB/);
    if (count === 0) {
      assert.doesNotMatch(actionable, /Docker dangling images/);
      assert.match(output, /3\.041GB retained; no dangling images/);
    } else assert.match(actionable, /Docker dangling images\s+Unknown\s+Prune dangling only \(3\)/);
  }
});

test('quick inspection measures supported caches only; verbose measures every configured cache', async () => {
  for (const verbose of [false, true]) {
    const measured = [];
    const report = await scanDeveloperStorage({ verbose, find: async name => name === 'docker' ? null : `/mock/${name}`,
      npmPath: async () => '/npm', goPaths: async () => ({ GOCACHE: '/go-build', GOMODCACHE: '/modules' }),
      env: { GRADLE_USER_HOME: '/gradle', DUPNEST_PNPM_STORE_PATH: '/pnpm', DUPNEST_YARN_CACHE_PATH: '/yarn' },
      measure: async target => { measured.push(target); return { complete: true, allocatedBytes: 123, errors: [] }; },
      run: async () => assert.fail('No tool execution expected'),
    });
    assert.deepEqual(measured.sort(), (verbose ? ['/npm', '/go-build', '/modules', '/gradle/caches', '/pnpm', '/yarn'] : ['/npm', '/go-build']).sort());
    assert.equal(report.errors.length, 0);
    assert.equal(report.caches.find(cache => cache.id === 'go-modules').usage.measurementSkipped, verbose ? undefined : true);
    assert.deepEqual(report.caches.map(cache => cache.id), ['npm', 'go-build', 'go-modules', 'pnpm', 'yarn', 'gradle']);
  }
});

test('Docker inspection overlaps cache measurement without completing before outstanding inspection', async () => {
  let releaseDocker;
  const measured = new Promise(resolve => { releaseDocker = resolve; });
  let finished = false;
  const report = await scanDeveloperStorage({ find: async name => ['docker', 'npm'].includes(name) ? `/mock/${name}` : null,
    npmPath: async () => '/npm', env: {},
    measure: async () => { releaseDocker(); return { complete: true, allocatedBytes: 42, errors: [] }; },
    run: async (cmd, args) => {
      await measured;
      if (args[0] === 'info') return { ok: true, stdout: '"daemon-id"' };
      if (args[0] === 'system') return { ok: true, stdout: '{"Type":"Images","Size":"1GB","Reclaimable":"0B"}' };
      finished = true;
      return { ok: true, stdout: '' };
    },
  });
  assert.equal(finished, true);
  assert.equal(report.dockerDanglingImages, 0);
  assert.equal(report.caches[0].usage.allocatedBytes, 42);
});

test('parallel measurement cannot enable cleanup for an external Go cache program', async () => {
  const report = await scanDeveloperStorage({ find: async name => name === 'go' ? '/mock/go' : null,
    goPaths: async () => ({ GOCACHE: '/build', GOMODCACHE: '/modules', GOCACHEPROG: '/cache-program' }),
    measure: async () => ({ complete: true, allocatedBytes: 12, errors: [] }), env: {},
  });
  assert.equal(report.caches.find(cache => cache.id === 'go-build').available, false);
});
