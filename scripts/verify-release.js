import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const { version: packageVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dupnest-release-check-'));

function run(command, args, { expected = 0, quiet = false, ...options } = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: project, encoding: 'utf8', timeout: 120000, ...options });
  if (!quiet || result.status !== expected || result.error) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  if (expected != null) assert.equal(result.status, expected);
  return result;
}

try {
  run('npm', ['test']);
  run('npm', ['run', 'check']);
  const cacheOptions = ['--cache', path.join(temporary, 'npm-cache'), '--logs-max=0'];
  run('npm', ['pack', '--dry-run', '--ignore-scripts', '--offline', ...cacheOptions], { quiet: true });
  const packed = run('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', temporary, ...cacheOptions], { quiet: true });
  const metadata = JSON.parse(packed.stdout)[0];
  assert.ok(metadata.files.some(file => file.path === 'bin/dupnest.js'));
  assert.ok(metadata.files.some(file => file.path === 'LICENSE'));
  assert.ok(metadata.files.every(file => /^(?:bin\/|src\/|README\.md$|LICENSE$|package\.json$)/.test(file.path)));
  const prefix = path.join(temporary, 'installation');
  run('npm', ['install', '--global', '--prefix', prefix, path.join(temporary, metadata.filename), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...cacheOptions]);
  const executable = path.join(prefix, 'bin', 'dupnest');
  assert.equal(run(executable, ['--version']).stdout.trim(), packageVersion);
  assert.match(run(executable, ['--help'], { quiet: true }).stdout, /dupnest dev clean/);
  const files = path.join(temporary, 'files');
  await mkdir(files);
  await writeFile(path.join(files, 'resume.pdf'), 'identical');
  await writeFile(path.join(files, 'resume (1).pdf'), 'different');
  await writeFile(path.join(files, 'another.pdf'), 'identical');
  for (const command of ['scan', 'clean', 'organize', 'tidy']) run(executable, [command, files, '--recursive', '--dry-run'], { quiet: true });
  for (const command of ['scan', 'clean', 'organize', 'tidy']) {
    const detailed = run(executable, [command, files, '--verbose', '--dry-run'], { quiet: true });
    if (['organize', 'tidy'].includes(command)) {
      assert.match(detailed.stdout, /PLANNED MOVE:/);
      assert.match(detailed.stdout, /Documents\s+3 files ->/);
    } else assert.match(detailed.stdout, /resume\.pdf/);
  }
  const mockBin = path.join(temporary, 'mock-bin'), cache = path.join(temporary, 'fixture-cache');
  await mkdir(mockBin);
  await mkdir(cache);
  await symlink(process.execPath, path.join(mockBin, 'node'));
  await writeFile(path.join(cache, 'content'), 'unchanged cache fixture');
  await writeFile(path.join(mockBin, 'npm'), '#!/usr/bin/env node\nif (process.argv.slice(2).join(" ") !== "config get cache") process.exit(87); process.stdout.write(process.env.DUPNEST_TEST_CACHE + "\\n");\n');
  await chmod(path.join(mockBin, 'npm'), 0o755);
  const env = { ...process.env, PATH: mockBin, DUPNEST_TEST_CACHE: cache };
  for (const command of ['scan', 'clean']) {
    for (const verbosity of [[], ['--verbose']]) {
      const developer = run(executable, ['dev', command, '--dry-run', ...verbosity], { quiet: true, env });
      assert.match(developer.stdout, /npm cache/);
      assert.equal(await readFile(path.join(cache, 'content'), 'utf8'), 'unchanged cache fixture');
    }
  }
  run(executable, ['clean', files], { expected: 1, quiet: true });
  run(executable, ['invalid'], { expected: 1, quiet: true });
  console.log('\nPackage installation and CLI smoke checks passed. Temporary build files will be removed.');
  if (process.argv.includes('--inspect-host')) {
    const started = performance.now();
    const host = run(executable, ['dev', 'scan'], { expected: null });
    assert.ok([0, 1].includes(host.status));
    console.log(`Host inspection exit code: ${host.status}; elapsed ${((performance.now() - started) / 1000).toFixed(2)} seconds. Tool availability/permission errors are reported above; no cleanup was run.`);
  }
} catch (error) {
  console.error(`Release verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
