import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('parses commands and flags in either order', () => {
  assert.deepEqual(parseArgs(['--recursive', 'scan', 'a b', '--dry-run']), { command: 'scan', path: 'a b', recursive: true, dryRun: true, verbose: false });
  assert.equal(parseArgs(['--verbose', 'organize']).verbose, true);
  assert.equal(parseArgs(['scan', '--verbose']).verbose, true);
  assert.equal(parseArgs(['clean', '--verbose']).verbose, true);
  assert.equal(parseArgs(['tidy', '--verbose', '--dry-run']).verbose, true);
  assert.equal(parseArgs(['dev', 'clean', '--dry-run']).command, 'dev clean');
  assert.equal(parseArgs(['dev', 'scan', '--verbose']).verbose, true);
  assert.equal(parseArgs(['dev', 'clean', '--verbose', '--dry-run']).verbose, true);
  assert.equal(parseArgs(['clean', '--', '-files']).path, '-files');
  assert.equal(parseArgs([]).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.equal(parseArgs(['organize', '--help']).command, 'help');
});

test('rejects invalid commands, options and extra paths', () => {
  for (const args of [['wat'], ['scan', '--yes'], ['dev'], ['dev', 'scan', 'x'], ['dev', 'scan', '--recursive'], ['scan', 'a', 'b'], ['--version', 'scan'], ['--dry-run'], ['--verbose'], ['--version', '--verbose']]) {
    assert.throws(() => parseArgs(args));
  }
});
