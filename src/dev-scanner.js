import path from 'node:path';
import { findExecutable, runProcess } from './process.js';
import { inodeKey, formatBytes, displayPath, issue } from './utils.js';
import { readGoCachePaths } from './go-config.js';
import { readNpmCachePath } from './npm-config.js';
import { walkDirectory } from './walker.js';

export async function measureDirectory(directory, options = {}) {
  const seen = new Set();
  let logicalBytes = 0, allocatedBytes = 0;
  let traversal;
  try {
    traversal = await walkDirectory(directory, { maxEntries: 100000, ...options, onEntry(target, stat) {
      if (!stat.isFile()) return;
      const key = inodeKey({ device: stat.dev, inode: stat.ino });
      if (!seen.has(key)) { seen.add(key); logicalBytes += stat.size; allocatedBytes += stat.blocks * 512; }
    } });
  } catch (error) {
    if (error.code === 'ENOENT') return { logicalBytes: 0, allocatedBytes: 0, complete: true, errors: [], absent: true };
    if (error instanceof RangeError) throw error;
    return { logicalBytes: null, allocatedBytes: null, complete: false, errors: [issue(directory, error)] };
  }
  return { ...traversal, logicalBytes: traversal.complete ? logicalBytes : null, allocatedBytes: traversal.complete ? allocatedBytes : null };
}

export function parseDockerUsage(output) {
  const trimmed = output.trim();
  if (!trimmed) throw new Error('Docker returned no usage data.');
  const rows = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !row || typeof row.Type !== 'string' || typeof row.Size !== 'string' || typeof row.Reclaimable !== 'string')) throw new Error('Unsupported Docker usage format.');
  return rows.map(row => ({ type: row.Type, usage: row.Size, reclaimable: row.Reclaimable,
    totalCount: /^(0|[1-9]\d*)$/.test(String(row.TotalCount)) && Number.isSafeInteger(Number(row.TotalCount)) ? Number(row.TotalCount) : null }));
}

export function parseDockerDaemonId(output) {
  const id = JSON.parse(output.trim());
  if (typeof id !== 'string' || !id.trim() || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Docker daemon identity unavailable.');
  return id;
}

export function dockerReportsZeroReclaimable(entry) {
  return /^0(?:\.0+)?\s*B(?:\s*\([^)]*\))?$/i.test(entry?.reclaimable?.trim() || '');
}

export function countDockerDanglingImages(output) {
  const ids = output.trim() ? output.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
  if (ids.some(id => typeof id !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(id))) throw new Error('Unsupported Docker image ID format.');
  return new Set(ids.map(id => id.replace(/^sha256:/i, '').toLowerCase())).size;
}

export const cacheCleanupAvailable = cache => Boolean(cache?.available && cache.usage?.complete && !cache.usage.absent);

export function dockerCleanupAvailable(report, type) {
  if (!report.docker.length || !report.dockerDaemon) return false;
  if (type === 'Images') return report.dockerDanglingImages !== 0;
  if (type === 'Build Cache') return !dockerReportsZeroReclaimable(report.docker.find(row => row.type === type));
  if (type === 'Containers') return report.docker.find(row => row.type === type)?.totalCount !== 0;
  return false;
}

function configuredPath(value) {
  const text = value.trim();
  if (!text || ['undefined', 'null', 'off'].includes(text)) throw new Error('Cache location unavailable or caching disabled.');
  let result = text;
  if (text.startsWith('"')) result = JSON.parse(text);
  if (typeof result !== 'string' || !path.isAbsolute(result) || result.includes('\n') || result.includes('\0')) throw new Error('Tool did not return a single absolute cache path.');
  return path.normalize(result);
}

export async function scanDeveloperStorage({ find = findExecutable, run = runProcess, measure = measureDirectory, goPaths = readGoCachePaths, npmPath = readNpmCachePath, env = process.env, verbose = false } = {}) {
  const report = { tools: {}, caches: [], docker: [], errors: [], env: { ...env }, dockerDaemon: null, dockerDanglingImages: null };
  const names = ['docker', 'npm', 'go', 'gradle', 'pnpm', 'yarn'];
  const found = await Promise.all(names.map(name => find(name, env)));
  names.forEach((name, index) => { report.tools[name] = { executable: found[index], status: 'Not found' }; });
  for (const tool of Object.values(report.tools)) if (tool.executable) tool.status = 'Installed';
  const jobs = [];
  const query = async (name, args) => {
    const result = await run(report.tools[name].executable, args, { env });
    if (!result.ok) throw new Error(result.stderr || result.error || `${name} inspection failed (${result.code})`);
    return result.stdout;
  };
  const addCache = (id, tool, label, getPath, advisory) => {
    if (!report.tools[tool].executable) return;
    const cache = { id, tool, label, path: null, usage: null, advisory, available: false };
    report.caches.push(cache);
    jobs.push((async () => {
      try {
        cache.path = configuredPath(await getPath());
        cache.usage = verbose || ['npm', 'go-build'].includes(id) ? await measure(cache.path) :
          { allocatedBytes: null, logicalBytes: null, complete: false, measurementSkipped: true, errors: [] };
        cache.available = true;
        if (id === 'go-build' && cache.externalProgram) cache.available = false;
        report.errors.push(...cache.usage.errors);
      } catch (error) { cache.warning = error.message; report.errors.push(issue(label, error)); }
    })());
    return cache;
  };
  if (report.tools.docker.executable) jobs.push((async () => {
    try {
      report.dockerDaemon = parseDockerDaemonId(await query('docker', ['info', '--format', '{{json .ID}}']));
      report.docker = parseDockerUsage(await query('docker', ['system', 'df', '--format', '{{json .}}']));
      // Total image storage includes tagged images. Inspect the supported prune
      // scope separately; a failed query must stay unknown, never become zero.
      try { report.dockerDanglingImages = countDockerDanglingImages(await query('docker', ['image', 'ls', '--filter', 'dangling=true', '--no-trunc', '--format', '{{json .ID}}'])); }
      catch (error) { report.errors.push(issue('Docker dangling images', error)); }
    }
    catch (error) { report.tools.docker.status = 'Installed, inspection unavailable'; report.errors.push(issue('Docker', error)); }
  })());
  addCache('npm', 'npm', 'npm cache', () => npmPath(report.tools.npm.executable, { run, env }), 'Supported: cache verify (maintenance); full clearing requires separate approval.');
  if (report.tools.go.executable) {
    let locations;
    // Even `go env` can write telemetry counters. Resolve the documented env
    // and GOENV configuration locally instead of starting Go during inspection.
    try { locations = await goPaths(report.tools.go.executable, env); }
    catch (error) { report.errors.push(issue('Go cache locations', error)); }
    if (locations) {
      const build = addCache('go-build', 'go', 'Go build cache', async () => locations.GOCACHE || '', locations.GOCACHEPROG ? 'External GOCACHEPROG is configured; local usage only, cleanup unavailable.' : 'Supported: go clean -cache.');
      if (build && locations.GOCACHEPROG) build.externalProgram = true;
      addCache('go-modules', 'go', 'Go module cache', async () => locations.GOMODCACHE || '', 'Scan-only in V1; Go supports go clean -modcache, which forces future downloads.');
    }
  }
  // Yarn Classic cache queries initialize directories; pnpm store path can
  // create filesystem probes or auto-install a pinned package-manager version.
  // Use explicit inspection paths instead of executing either tool during scans.
  for (const [id, label, setting, advisory] of [
    ['pnpm', 'pnpm store', 'DUPNEST_PNPM_STORE_PATH', 'Scan-only in V1. Review pnpm store prune in your pnpm documentation.'],
    ['yarn', 'Yarn cache', 'DUPNEST_YARN_CACHE_PATH', 'Scan-only in V1. Review yarn cache clean for your Yarn version and project.'],
  ]) {
    if (!report.tools[id].executable) continue;
    const location = env[setting] || (id === 'yarn' ? env.YARN_CACHE_FOLDER : null);
    if (location) addCache(id, id, label, async () => location, advisory);
    else report.caches.push({ id, tool: id, label, available: false, usage: null,
      warning: `Path unknown. Set ${setting} to an existing absolute configured cache path. CLI discovery is avoided because it may write files.`, advisory });
  }
  if (report.tools.gradle.executable) {
    // Running Gradle may execute project build logic and create caches. There is
    // no read-only CLI query for the effective user home across configurations.
    const overridden = /(?:^|\s)-Dgradle\.user\.home(?:=|\s)/.test(`${env.GRADLE_OPTS || ''} ${env.JAVA_OPTS || ''}`);
    if (env.GRADLE_USER_HOME && !overridden) addCache('gradle', 'gradle', 'Gradle cache', async () => path.join(configuredPath(env.GRADLE_USER_HOME), 'caches'), 'Scan-only; automatic Gradle cache retention is managed by Gradle.');
    else report.caches.push({ id: 'gradle', tool: 'gradle', label: 'Gradle cache', available: false, usage: null, warning: 'Effective user home unknown. Set an absolute GRADLE_USER_HOME with no -Dgradle.user.home override to inspect it; project/CLI overrides cannot be discovered safely.', advisory: 'Scan-only; Gradle is not executed during inspection.' });
  }
  const settled = await Promise.allSettled(jobs);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  return report;
}

function printCompactStorage(report, ui, command) {
  const rows = [], retained = [];
  const safe = value => displayPath(value).slice(1, -1);
  for (const [id, label, action] of [
    ['npm', 'npm cache', 'Verify; full clear optional'],
    ['go-build', 'Go build cache', 'Clear build cache'],
  ]) {
    const cache = report.caches.find(entry => entry.id === id);
    if (cacheCleanupAvailable(cache)) rows.push([label, formatBytes(cache.usage.allocatedBytes), action]);
    else if (cache && !cache.usage?.absent) retained.push(`${label}: cleanup unavailable; use --verbose for the reason.`);
  }
  for (const [type, label, action] of [
    ['Images', 'Docker dangling images', `Prune dangling only${report.dockerDanglingImages > 0 ? ` (${report.dockerDanglingImages})` : ''}`],
    ['Build Cache', 'Docker build cache', 'Prune dangling only'],
    ['Containers', 'Docker containers', 'Prune stopped; extra approval'],
  ]) if (dockerCleanupAvailable(report, type)) rows.push([label, 'Unknown', action]);
  if (report.tools.docker?.executable && !report.docker.length) retained.push('Docker: inspection unavailable; use --verbose for the reason.');
  for (const entry of report.docker) {
    if (entry.type === 'Images' && report.dockerDanglingImages === 0) retained.push(`Docker images: ${safe(entry.usage)} retained; no dangling images. Tagged images are kept.`);
    if (entry.type === 'Build Cache' && dockerReportsZeroReclaimable(entry)) retained.push(`Docker build cache: ${safe(entry.usage)} retained; Docker reports 0 B reclaimable.`);
    if (entry.type === 'Local Volumes' && !/^0(?:\.0+)?\s*B$/i.test(entry.usage.trim())) retained.push(`Docker volumes: ${safe(entry.usage)}; scan only.`);
  }
  const advisory = report.caches.filter(cache => !['npm', 'go-build'].includes(cache.id)).map(cache => cache.label);
  if (advisory.length) retained.push(`${advisory.join(', ')}: scan only; details with --verbose.`);
  ui.print(`\nDupNest — Developer ${command === 'dev clean' ? 'Cleanup' : 'Storage'}\n`);
  ui.print('Supported cleanup:');
  if (rows.length) {
    ui.print(`${'Target'.padEnd(24)} ${'Cache used'.padEnd(14)} Action`);
    for (const [label, used, action] of rows) ui.print(`${label.padEnd(24)} ${used.padEnd(14)} ${action}`);
  } else ui.print('  No supported cleanup targets found.');
  if (retained.length) {
    ui.print('\nNot cleaned by these actions:');
    for (const line of retained) ui.print(`  ${line}`);
  }
  ui.print('\nCache used is current usage, not expected savings. Reclaimable bytes are unknown; categories are not summed.');
  if (rows.some(([label]) => label === 'npm cache')) ui.print('npm verification keeps valid packages; clearing package contents forces future downloads.');
  if (report.errors.length) ui.print(`Inspection incomplete: ${report.errors.length} error(s). Use --verbose for paths and reasons.`);
  if (command !== 'dev clean') ui.print('Run dupnest dev clean to choose an action. Use --verbose for the full storage inventory.');
}

export function printDeveloperStorage(report, ui, { verbose = false, command } = {}) {
  if (!verbose) { printCompactStorage(report, ui, command); return; }
  ui.print('\nDupNest — Developer Storage');
  for (const [name, tool] of Object.entries(report.tools)) ui.print(`${name.padEnd(9)} ${tool.status}`);
  if (report.docker.length) {
    ui.print('\nDocker usage (daemon estimates; categories may share storage):');
    for (const row of report.docker) ui.print(`  ${displayPath(row.type)}: usage ${displayPath(row.usage)}; Docker-reported reclaimable ${displayPath(row.reclaimable)}`);
    ui.print(`Dangling images: ${report.dockerDanglingImages ?? 'unknown'}. Total image usage includes tagged images, which dangling-only cleanup preserves.`);
    ui.print('Docker reclaimable totals are advisory and may exceed the scope of supported cleanup. Volumes are scan-only. No categories are summed.');
  }
  for (const cache of report.caches) {
    ui.print(`\n${cache.label}: ${formatBytes(cache.usage?.allocatedBytes)} allocated (approximate usage; not guaranteed reclaimable)`);
    if (cache.path) ui.print(`  Path: ${displayPath(cache.path)}`);
    if (cache.warning) ui.print(`  Unavailable: ${displayPath(cache.warning)}`);
    ui.print(`  ${cache.advisory}`);
  }
  for (const error of report.errors) ui.print(`Inspection error: ${displayPath(error.path)}: ${displayPath(error.message)}`);
  ui.print('\nPotential reclaimable total: unknown. Cache usage is not a promise of recovered space; overlapping paths and Docker storage are not summed.');
}
