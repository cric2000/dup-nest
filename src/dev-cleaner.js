import { runProcess } from './process.js';
import { stripVTControlCharacters } from 'node:util';
import { measureDirectory, parseDockerDaemonId, dockerReportsZeroReclaimable, cacheCleanupAvailable, dockerCleanupAvailable } from './dev-scanner.js';
import { assertDirectories, displayPath, formatBytes, issue } from './utils.js';
import { requireInteractive } from './ui.js';

export function cleanupCandidates(report) {
  const candidates = [];
  const npm = report.caches.find(cache => cache.id === 'npm' && cacheCleanupAvailable(cache));
  const go = report.caches.find(cache => cache.id === 'go-build' && cacheCleanupAvailable(cache));
  if (npm) {
    candidates.push({ id: 'npm-verify', tool: 'npm', label: 'npm cache verification and garbage collection (preferred)', args: ['cache', 'verify', '--cache', npm.path], cache: npm });
    candidates.push({ id: 'npm-clear', tool: 'npm', label: 'Clear npm package cache (higher impact; forces future downloads)', args: ['cache', 'clean', '--force', '--cache', npm.path], cache: npm, extra: 'Clear the configured npm package cache contents?' });
  }
  if (go) candidates.push({ id: 'go-build', tool: 'go', label: 'Go build cache (future builds must rebuild)', args: ['clean', '-cache'], cache: go });
  if (report.docker.length && report.dockerDaemon) {
    if (dockerCleanupAvailable(report, 'Build Cache')) candidates.push({ id: 'docker-build', tool: 'docker', label: 'Docker dangling build cache', args: ['builder', 'prune', '--force'] });
    if (dockerCleanupAvailable(report, 'Images')) candidates.push({ id: 'docker-images', tool: 'docker', label: 'Docker dangling images only', args: ['image', 'prune', '--force'] });
    if (dockerCleanupAvailable(report, 'Containers')) candidates.push({ id: 'docker-containers', tool: 'docker', label: 'ALL stopped Docker containers (valuable writable-layer data may be lost)', args: ['container', 'prune', '--force'], extra: 'Permanently discard ALL stopped containers, including their writable-layer data?' });
  }
  return candidates;
}

function printOperation(ui, operation, report) {
  ui.print(`  ${operation.label}`);
  if (operation.cache) ui.print(`    Cache: ${displayPath(operation.cache.path)}`);
  if (operation.tool === 'go') ui.print(`    Environment: GOCACHE=${displayPath(operation.cache.path)}`);
  if (operation.tool === 'docker') ui.print(`    Docker daemon ID: ${displayPath(report.dockerDaemon)}`);
  ui.print(`    Command arguments: ${displayPath(report.tools[operation.tool].executable)} ${operation.args.map(displayPath).join(' ')}`);
}

function printToolText(ui, label, text, verbose) {
  if (!text?.trim()) return;
  const full = stripVTControlCharacters(text).trim().split(/\r\n|\r|\n/).map(line => line.replace(/\t/g, '    ')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
  let lines = full;
  if (!verbose) {
    lines = full.slice(0, 3);
    const summary = full.findLast(line => /^Total reclaimed space:/i.test(line.trim()));
    if (summary && !lines.includes(summary)) lines[2] = summary;
    lines = lines.map(line => line.slice(0, 160));
  }
  ui.print(`${label}:`);
  for (const line of lines) ui.print(`  ${line}`);
  if (lines.length !== full.length || lines.some((line, index) => line !== full[index])) ui.print('Additional tool output omitted; use --verbose when running cleanup for the full log.');
}

export async function cleanDeveloperStorage(report, ui, { dryRun = false, verbose = false, run = runProcess, measure = measureDirectory, now = () => performance.now() } = {}) {
  if (!dryRun) requireInteractive(ui);
  const candidates = cleanupCandidates(report);
  const result = { completed: [], skipped: [], errors: [], measurements: [], commandMs: 0 };
  ui.print('\nDeveloper cleanup candidates:');
  candidates.forEach((operation, index) => {
    if (dryRun || verbose) { ui.print(`${index + 1}.`); printOperation(ui, operation, report); }
    else ui.print(`${index + 1}. ${operation.label}`);
  });
  if (verbose) {
    if (dockerReportsZeroReclaimable(report.docker.find(row => row.type === 'Build Cache'))) ui.print('Docker build cache omitted: Docker reports 0 B reclaimable. Shared or in-use layers may remain.');
    if (report.dockerDanglingImages === 0) ui.print('Docker image cleanup omitted: no dangling images found. Total image usage includes retained tagged images.');
    if (report.docker.find(row => row.type === 'Containers')?.totalCount === 0) ui.print('Docker container cleanup omitted: no containers exist.');
  }
  if (!candidates.length) { ui.print('No supported, accessible cleanup candidates.'); return result; }
  ui.print('Cache maintenance may require downloads or rebuilds.');
  if (candidates.some(operation => operation.tool === 'docker')) ui.print('Docker pruning is generally irreversible. Volumes are never cleaned.');
  if (dryRun) { ui.print('Dry-run: these are selectable alternatives, not an approved batch. No maintenance or pruning commands executed.'); return result; }
  let selected;
  while (true) {
    const input = (await ui.ask('Select categories (comma-separated numbers; Enter to cancel): ')).trim();
    if (!input) return result;
    const parts = input.split(',').map(value => value.trim());
    if (parts.every(value => /^[1-9]\d*$/.test(value) && Number(value) <= candidates.length)) {
      selected = [...new Set(parts.map(Number))].map(number => candidates[number - 1]);
      if (!(selected.some(op => op.id === 'npm-verify') && selected.some(op => op.id === 'npm-clear'))) break;
      ui.print('Choose npm verification OR full clearing, not both.');
    } else ui.print('Enter only listed category numbers separated by commas.');
  }
  ui.print('\nSelected operations:');
  for (const operation of selected) printOperation(ui, operation, report);
  if (!await ui.confirm('Proceed with the selected developer cleanup operations?')) return result;
  for (const operation of selected) {
    if (operation.extra && !await ui.confirm(operation.extra)) { result.skipped.push(operation.id); continue; }
    try {
      requireInteractive(ui);
      const env = { ...report.env };
      let before;
      if (operation.cache) {
        if (operation.cache.usage.parents) await assertDirectories(operation.cache.usage.parents);
        before = await measure(operation.cache.path);
        if (!before.complete || before.absent) throw new Error('Cache path is unavailable or changed; scan again.');
        if (operation.tool === 'go') env.GOCACHE = operation.cache.path;
      }
      if (operation.tool === 'docker') {
        const identity = await run(report.tools.docker.executable, ['info', '--format', '{{json .ID}}'], { env });
        if (!identity.ok || parseDockerDaemonId(identity.stdout) !== report.dockerDaemon) throw new Error('Docker daemon changed or is inaccessible; scan again.');
      }
      if (operation.cache?.usage.parents) await assertDirectories(operation.cache.usage.parents);
      requireInteractive(ui);
      const started = now();
      let executed;
      try { executed = await run(report.tools[operation.tool].executable, operation.args, { timeout: 600000, env }); }
      finally { result.commandMs += Math.max(0, now() - started); }
      if (!executed.ok) throw new Error(`${executed.stderr || executed.error || `Exit ${executed.code}`}. Partial changes may have occurred; inspect the cache before retrying.`);
      result.completed.push(operation.id);
      ui.print(`Completed: ${operation.label}`);
      printToolText(ui, 'Tool output', executed.stdout, verbose);
      printToolText(ui, 'Tool diagnostic', executed.stderr, verbose);
      if (operation.tool === 'docker' && /^Total reclaimed space:\s*0(?:\.0+)?\s*B\s*$/im.test(executed.stdout || '')) ui.print('No disk space reclaimed: Docker reported 0 B for this operation.');
      if (operation.cache) {
        const after = await measure(operation.cache.path);
        const decrease = before.complete && after.complete ? Math.max(0, before.allocatedBytes - after.allocatedBytes) : null;
        result.measurements.push({ id: operation.id, observedDecrease: decrease });
        ui.print(`Observed allocated-cache decrease: ${formatBytes(decrease)} (approximate; concurrent activity and shared storage may affect this).`);
      }
    } catch (error) { result.errors.push(issue(operation.label, error)); ui.print(`Failed: ${operation.label}`); printToolText(ui, 'Reason', error.message, true); }
  }
  ui.print(`\nOperations completed: ${result.completed.length}\nOperations skipped: ${result.skipped.length}\nErrors: ${result.errors.length}\nVerified physical space reclaimed: unknown. Tool output and cache-size changes are observations, not guarantees.`);
  ui.print(`Cleanup command time: ${(result.commandMs / 1000).toFixed(2)} s (excludes prompts, inspection, and storage measurements).`);
  return result;
}
