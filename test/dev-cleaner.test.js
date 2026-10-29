import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDeveloperStorage, cleanupCandidates } from '../src/dev-cleaner.js';
import { fakeUI } from './helpers.js';

function report() {
  return {
    tools: { npm: { executable: '/mock/npm' }, go: { executable: '/mock/go' }, docker: { executable: '/mock/docker' } },
    caches: [
      { id: 'npm', available: true, path: '/cache/npm $(touch unsafe)', usage: { complete: true } },
      { id: 'go-build', available: true, path: '/cache/go build', usage: { complete: true } },
    ], docker: [{ type: 'Images' }], dockerDaemon: 'daemon-id', env: {},
  };
}
const measure = async () => ({ complete: true, allocatedBytes: 100 });

test('candidate commands have strict scope, no broad prune or volume operations', () => {
  const operations = cleanupCandidates(report());
  assert.deepEqual(operations.map(op => op.args.slice(0, 2)), [['cache', 'verify'], ['cache', 'clean'], ['clean', '-cache'], ['builder', 'prune'], ['image', 'prune'], ['container', 'prune']]);
  assert.ok(operations.every(op => !op.args.some(arg => ['-a', '--all', '--volumes', 'volume', 'system', '-modcache'].includes(arg))));
});

test('dry-run and rejected/default confirmation never invoke commands', async () => {
  const run = async () => assert.fail('Cleanup must not execute');
  await cleanDeveloperStorage(report(), fakeUI([], false), { dryRun: true, run });
  await cleanDeveloperStorage(report(), fakeUI(['1', '']), { run });
  await cleanDeveloperStorage(report(), fakeUI(['1', 'n']), { run });
  await cleanDeveloperStorage(report(), fakeUI(['']), { run });
  await assert.rejects(cleanDeveloperStorage(report(), fakeUI([], false), { run }), /interactive/);
});

test('only selected operations execute, with literal argument arrays and cache pinning', async () => {
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { ok: true, stdout: args[0] === 'info' ? '"daemon-id"' : '', stderr: '' };
  };
  const result = await cleanDeveloperStorage(report(), fakeUI(['1,3,4,5', 'y']), { run, measure });
  assert.deepEqual(result.completed, ['npm-verify', 'go-build', 'docker-build', 'docker-images']);
  assert.deepEqual(calls[0].args, ['cache', 'verify', '--cache', '/cache/npm $(touch unsafe)']);
  assert.equal(calls[1].options.env.GOCACHE, '/cache/go build');
  assert.equal(calls.filter(c => c.args.includes('prune')).length, 2);
  assert.equal(result.measurements.length, 2);
});

test('stopped containers and full npm clearing each require extra approval', async () => {
  let calls = [];
  const run = async (cmd, args) => { calls.push(args); return { ok: true, stdout: args[0] === 'info' ? '"daemon-id"' : '', stderr: '' }; };
  let result = await cleanDeveloperStorage(report(), fakeUI(['2,6', 'yes', '', 'n']), { run, measure });
  assert.equal(calls.length, 0);
  assert.equal(result.skipped.length, 2);
  result = await cleanDeveloperStorage(report(), fakeUI(['2,6', 'yes', 'yes', 'yes']), { run, measure });
  assert.deepEqual(result.completed, ['npm-clear', 'docker-containers']);
  assert.ok(calls.some(args => args[0] === 'container' && args[1] === 'prune'));
});

test('changed daemon prevents pruning and failed commands report errors', async () => {
  const calls = [];
  const run = async (cmd, args) => { calls.push(args); return { ok: args[0] === 'info', stdout: '"other-daemon"', stderr: 'failure' }; };
  const result = await cleanDeveloperStorage(report(), fakeUI(['1,4', 'y']), { run, measure });
  assert.equal(result.completed.length, 0);
  assert.equal(result.errors.length, 2);
  assert.equal(calls.filter(args => args.includes('prune')).length, 0);
});

test('invalid selection and conflicting npm operations require reselection', async () => {
  const result = await cleanDeveloperStorage(report(), fakeUI(['99', '1,2', '1; rm', '', 'unused']), { run: async () => assert.fail('No operation approved') });
  assert.equal(result.completed.length, 0);
});

test('successful command alone does not establish recovered space', async () => {
  const ui = fakeUI(['1', 'y']);
  let measurements = 0;
  const result = await cleanDeveloperStorage(report(), ui, { run: async () => ({ ok: true, stdout: '', stderr: '' }), measure: async () => ({ complete: true, allocatedBytes: measurements++ ? 50 : 100 }) });
  assert.equal(result.measurements[0].observedDecrease, 50);
  assert.ok(ui.output.some(line => line.includes('Verified physical space reclaimed: unknown')));
});

test('developer cleanup menu is compact until selection, while dry-run lists exact command alternatives', async () => {
  const ui = fakeUI(['']);
  await cleanDeveloperStorage(report(), ui, { run: async () => assert.fail('No cleanup was approved') });
  assert.equal(ui.output.filter(line => line.includes('Command arguments:')).length, 0);
  assert.equal(ui.output.filter(line => /^\d+\. /.test(line)).length, 6);
  const dryRun = fakeUI([], false);
  await cleanDeveloperStorage(report(), dryRun, { dryRun: true, run: async () => assert.fail('Dry-run must not mutate') });
  assert.equal(dryRun.output.filter(line => line.includes('Command arguments:')).length, 6);
});

test('selected cleanup retains exact commands but successful bulk tool output is bounded unless verbose', async () => {
  const output = Array.from({ length: 1000 }, (_, i) => `resource-${i}`).join('\n');
  const run = async () => ({ ok: true, stdout: output, stderr: '' });
  const compact = fakeUI(['1', 'y']);
  await cleanDeveloperStorage(report(), compact, { run, measure });
  assert.equal(compact.output.filter(line => line.includes('Command arguments:')).length, 1);
  assert.ok(compact.output.join('\n').length < 4000);
  assert.ok(compact.output.some(line => line.includes('Additional tool output omitted')));
  const verbose = fakeUI(['1', 'y']);
  await cleanDeveloperStorage(report(), verbose, { verbose: true, run, measure });
  assert.ok(verbose.output.some(line => line.includes('resource-999')));
});

test('known Docker no-ops are omitted; missing measurements and zero-size containers remain selectable', async () => {
  const data = report();
  data.docker.push({ type: 'Build Cache', usage: '561.9MB', reclaimable: '0B' }, { type: 'Containers', usage: '0B', totalCount: 0 });
  assert.deepEqual(cleanupCandidates(data).map(op => op.id), ['npm-verify', 'npm-clear', 'go-build', 'docker-images']);
  const ui = fakeUI([], false);
  await cleanDeveloperStorage(data, ui, { dryRun: true, verbose: true });
  assert.ok(ui.output.some(line => line.includes('0 B reclaimable')));
  assert.ok(ui.output.some(line => line.includes('no containers exist')));
  data.docker[1].reclaimable = 'unknown';
  data.docker[2].totalCount = 1;
  assert.equal(cleanupCandidates(data).length, 6);
});

test('tool logs render actual lines, remove terminal controls, and retain Docker reclaimed summary', async () => {
  const ui = fakeUI(['4', 'y']);
  const run = async (cmd, args) => ({ ok: true, stdout: args[0] === 'info' ? '"daemon-id"' : '\x1b[31mDeleted:\x1b[0m\nitem1\nitem2\nitem3\nTotal reclaimed space: 0B\n', stderr: 'warning\nnext\x07\u202e' });
  await cleanDeveloperStorage(report(), ui, { run });
  assert.ok(ui.output.includes('  Deleted:'));
  assert.ok(ui.output.includes('  Total reclaimed space: 0B'));
  assert.ok(ui.output.some(line => line.includes('No disk space reclaimed')));
  assert.ok(ui.output.includes('  next\\u0007\\u202e'));
  assert.ok(!ui.output.join('\n').includes('\x1b'));
  assert.ok(ui.output.includes('    Docker daemon ID: "daemon-id"'));
});

test('cleanup timing excludes human prompts, daemon checks, and cache measurement', async () => {
  let time = 0;
  const ui = fakeUI(['1', 'y']);
  const ask = ui.ask.bind(ui), confirm = ui.confirm.bind(ui);
  ui.ask = async (...args) => { time += 50000; return ask(...args); };
  ui.confirm = async (...args) => { time += 50000; return confirm(...args); };
  const result = await cleanDeveloperStorage(report(), ui, {
    now: () => time,
    measure: async () => { time += 10000; return { complete: true, allocatedBytes: 100 }; },
    run: async () => { time += 1250; return { ok: true, stdout: '', stderr: '' }; },
  });
  assert.equal(result.commandMs, 1250);
  assert.ok(ui.output.some(line => line.includes('Cleanup command time: 1.25 s')));
});

test('malformed daemon identities never permit pruning', async () => {
  const calls = [];
  const result = await cleanDeveloperStorage(report(), fakeUI(['4', 'y']), { run: async (cmd, args) => { calls.push(args); return { ok: true, stdout: '{}', stderr: '' }; } });
  assert.equal(result.errors.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'info');
});

test('no dangling images omits image cleanup while unknown or positive counts preserve the option', async () => {
  const data = { ...report(), dockerDanglingImages: 0 };
  assert.ok(!cleanupCandidates(data).some(op => op.id === 'docker-images'));
  const ui = fakeUI([], false);
  await cleanDeveloperStorage(data, ui, { dryRun: true, verbose: true, run: async () => assert.fail('No cleanup allowed') });
  assert.ok(ui.output.some(line => line.includes('no dangling images found')));
  for (const count of [null, undefined, 1]) assert.ok(cleanupCandidates({ ...data, dockerDanglingImages: count }).some(op => op.id === 'docker-images'));
});

test('normal menu avoids repeated Docker omissions and Docker warnings when only npm and Go are offered', async () => {
  const data = { ...report(), dockerDanglingImages: 0, docker: [{ type: 'Images' }, { type: 'Build Cache', reclaimable: '0B' }, { type: 'Containers', totalCount: 0 }] };
  const ui = fakeUI(['']);
  await cleanDeveloperStorage(data, ui, { run: async () => assert.fail('Nothing approved') });
  assert.equal(ui.output.filter(line => /^\d+\. /.test(line)).length, 3);
  assert.doesNotMatch(ui.output.join('\n'), /Docker.*omitted|Docker pruning is generally irreversible/);
});
