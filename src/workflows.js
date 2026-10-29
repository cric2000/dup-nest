import { scanDirectory } from './scanner.js';
import { findDuplicates } from './duplicates.js';
import { findVersions, buildReviewGroups } from './versions.js';
import { cleanGroups } from './cleaner.js';
import { planOrganization, organize } from './organizer.js';
import { createUI, requireInteractive, printFiles, printErrors } from './ui.js';
import { formatBytes } from './utils.js';

export async function analyzeDirectory(input, options) {
  const scan = await scanDirectory(input, options);
  const duplicates = await findDuplicates(scan.files);
  const versions = await findVersions(scan.files, { hashes: duplicates.hashes });
  return { scan, duplicates, versions, errors: [...scan.errors, ...duplicates.errors, ...versions.errors],
    groups: buildReviewGroups(duplicates.groups, versions.groups, versions.hashes), hashes: versions.hashes };
}

export function printAnalysis(analysis, ui, { verbose = false } = {}) {
  const { scan, duplicates, versions, errors } = analysis;
  ui.print(`\nDupNest — Duplicate Scan\nScanning: ${JSON.stringify(scan.root)}`);
  ui.print(`Files scanned: ${scan.files.length}\nSkipped links, special files, incomplete downloads: ${scan.skipped}`);
  ui.print(`Exact duplicate groups: ${duplicates.groups.length}\nPossible version groups: ${versions.groups.filter(g => g.kind !== 'exact').length}`);
  if (verbose) duplicates.groups.forEach((group, index) => {
    ui.print(`\nExact duplicate group ${index + 1}:`);
    printFiles(ui, group.files);
    ui.print(`  Distinct redundant copies: ${group.redundantCopies}; potential redundant content: ${formatBytes(group.potentialBytes)}`);
  });
  for (const group of verbose ? versions.groups.filter(g => g.kind !== 'exact') : []) {
    ui.print(`\n${group.kind === 'uncertain' ? 'Uncertain versions (hashing failed)' : 'Possible different versions'}:`);
    printFiles(ui, group.files);
    ui.print(`Suggested review candidate: ${JSON.stringify(group.suggested.path)} — most recently modified; timestamps do not prove content freshness.`);
  }
  ui.print(`\nPotential duplicate savings: ${formatBytes(duplicates.potentialBytes)} (logical content estimate, counted once per inode; excludes external hard links).`);
  ui.print('Actual physical savings may differ for sparse, compressed or reflinked files. Trash retains storage until emptied separately.');
  if (!verbose && analysis.groups.length) ui.print('Use dupnest scan --verbose for matching paths, sizes, and timestamps. Cleanup shows every affected file before approval.');
  if (errors.length) ui.print(`Scan incomplete: ${errors.length} error(s). Results describe readable, stable files only.`);
  printErrors(ui, errors);
}

export async function runCommand(args, { ui = createUI() } = {}) {
  try {
    if (args.command.startsWith('dev ')) {
      if (args.command === 'dev clean' && !args.dryRun) requireInteractive(ui);
      const { scanDeveloperStorage, printDeveloperStorage } = await import('./dev-scanner.js');
      const report = await scanDeveloperStorage({ verbose: args.verbose });
      printDeveloperStorage(report, ui, args);
      if (args.command === 'dev scan') return report.errors.length ? 1 : 0;
      const { cleanDeveloperStorage } = await import('./dev-cleaner.js');
      const result = await cleanDeveloperStorage(report, ui, args);
      return report.errors.length || result.errors.length ? 1 : 0;
    }
    if (args.command !== 'scan' && !args.dryRun) requireInteractive(ui);
    if (args.command === 'organize') {
      if (args.recursive) ui.print('--recursive does not expand organization scope; only top-level files are organized.');
      const scan = await scanDirectory(args.path);
      if (scan.errors.length) { printErrors(ui, scan.errors); ui.print('Incomplete scan; organization stopped.'); return 1; }
      const result = await organize(await planOrganization(scan), ui, args);
      ui.print(`Errors: ${result.errors.length}`);
      return result.errors.length ? 1 : 0;
    }
    const analysis = await analyzeDirectory(args.path, args);
    printAnalysis(analysis, ui, { verbose: args.command === 'scan' && (args.verbose || args.dryRun) });
    if (args.command === 'scan') { ui.print('\nNo files modified.'); return analysis.errors.length ? 1 : 0; }
    if (analysis.errors.length && !args.dryRun) { ui.print('Incomplete scan; fix the reported errors and scan again before cleanup.'); return 1; }
    let cleanup = { trashed: 0, renamed: 0, errors: [] };
    if (args.command === 'clean' || args.dryRun || (analysis.groups.length && await ui.confirm('Review duplicate and version groups?'))) {
      cleanup = await cleanGroups(analysis.groups, analysis.hashes, ui, args);
    }
    let organization = { moved: 0, errors: [] };
    if (args.command === 'tidy' && (args.dryRun || await ui.confirm('Preview organization of remaining top-level files?'))) {
      // Refresh after approved cleanup/rename; old paths must never be reused.
      const refreshed = await scanDirectory(args.path);
      if (refreshed.errors.length) { printErrors(ui, refreshed.errors); organization.errors.push(...refreshed.errors); }
      else organization = await organize(await planOrganization(refreshed), ui, args);
    }
    const errors = analysis.errors.length + cleanup.errors.length + organization.errors.length;
    ui.print(`\n${args.dryRun ? 'Dry-run summary' : 'Summary'}:\nFiles moved to Trash: ${cleanup.trashed}\nFiles renamed: ${cleanup.renamed}\nFiles organized: ${organization.moved}\nVerified space reclaimed by file operations: 0 B (Trash is retained)\nErrors: ${errors}`);
    return errors ? 1 : 0;
  } finally { ui.close?.(); }
}
