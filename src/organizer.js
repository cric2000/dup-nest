import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { exists, assertDirectories, directoryChain, displayPath, issue } from './utils.js';
import { moveNoReplace } from './move.js';
import { requireInteractive, printErrors } from './ui.js';

const CATEGORIES = {
  Documents: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.csv', '.xls', '.xlsx', '.ppt', '.pptx'],
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'],
  Videos: ['.mp4', '.mkv', '.mov', '.avi', '.webm'],
  Audio: ['.mp3', '.wav', '.ogg', '.flac', '.m4a'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'],
  Installers: ['.deb', '.appimage', '.rpm'],
};
const EXTENSIONS = new Map(Object.entries(CATEGORIES).flatMap(([category, extensions]) => extensions.map(ext => [ext, category])));
export const categoryFor = name => EXTENSIONS.get(path.extname(name).toLowerCase()) || 'Others';

export async function planOrganization(scan, { readDirectory = readdir } = {}) {
  const operations = [], errors = [];
  const directories = new Map();
  for (const file of scan.files) {
    // Even when handed a recursive scan, never flatten nested project files.
    if (path.dirname(file.path) !== scan.root) continue;
    const directory = path.join(scan.root, categoryFor(file.name));
    try {
      if (!directories.has(directory)) {
        const parents = await exists(directory) ? await directoryChain(directory) : null;
        const occupied = new Set(parents ? await readDirectory(directory) : []);
        if (parents) await assertDirectories(parents);
        directories.set(directory, { parents, occupied });
      }
      const { parents, occupied } = directories.get(directory);
      const extension = path.extname(file.name);
      const stem = extension ? file.name.slice(0, -extension.length) : file.name;
      let destination = path.join(directory, file.name);
      let suffix = 1;
      while (occupied.has(path.basename(destination))) destination = path.join(directory, `${stem} (${suffix++})${extension}`);
      occupied.add(path.basename(destination));
      operations.push({ file, destination, directory, parents });
    } catch (error) { errors.push(issue(file.path, error)); }
  }
  return { root: scan.root, parents: scan.parents, operations, errors };
}

export async function organize(plan, ui, { dryRun = false, verbose = false, move = moveNoReplace } = {}) {
  const result = { moved: 0, errors: [...plan.errors] };
  if (!dryRun) requireInteractive(ui);
  ui.print(`\nOrganize ${displayPath(plan.root)}`);
  ui.print('Top-level regular files only; nested directories and category contents stay in place.');
  const categories = new Map();
  for (const operation of plan.operations) {
    const count = categories.get(operation.directory) || 0;
    categories.set(operation.directory, count + 1);
  }
  for (const [directory, count] of [...categories].sort(([a], [b]) => a.localeCompare(b))) {
    ui.print(`  ${path.basename(directory).padEnd(12)} ${String(count).padStart(5)} ${count === 1 ? 'file ' : 'files'} -> ${displayPath(directory)}`);
  }
  const collisions = plan.operations.filter(operation => path.basename(operation.destination) !== operation.file.name).length;
  ui.print(`Filename collisions: ${collisions}${collisions ? ' (numbered suffixes will preserve existing files)' : ''}`);
  if (dryRun || verbose) {
    ui.print('\nPlanned moves — no files moved yet:');
    for (const operation of plan.operations) ui.print(`PLANNED MOVE: ${displayPath(operation.file.path)} -> ${displayPath(operation.destination)}`);
  } else if (plan.operations.length) ui.print('Use --dry-run or --verbose to see individual moves.');
  printErrors(ui, plan.errors);
  if (!plan.operations.length) { ui.print('No top-level files to organize.'); return result; }
  if (dryRun) { ui.print('Dry-run: no files moved or directories created.'); return result; }
  const count = plan.operations.length;
  if (!await ui.confirm(`Organize ${count} ${count === 1 ? 'file' : 'files'} into ${categories.size} ${categories.size === 1 ? 'folder' : 'folders'}?`)) {
    ui.print('Organization cancelled. No files moved.');
    return result;
  }
  const created = new Map();
  const completedDirectories = new Set();
  for (const operation of plan.operations) {
    try {
      requireInteractive(ui);
      await assertDirectories(plan.parents);
      if (operation.parents) await assertDirectories(operation.parents);
      else if (created.has(operation.directory)) await assertDirectories(created.get(operation.directory));
      else {
        // EEXIST after planning is a race, so stop this operation rather than
        // accepting an unreviewed directory or symlink.
        await mkdir(operation.directory);
        created.set(operation.directory, await directoryChain(operation.directory));
      }
      await move(operation.file, operation.destination);
      result.moved++;
      completedDirectories.add(operation.directory);
      if (verbose) ui.print(`Organized: ${displayPath(operation.destination)}`);
    } catch (error) {
      const failure = issue(operation.file.path, error);
      result.errors.push(failure);
      printErrors(ui, [failure]);
    }
  }
  ui.print(`\nOrganized ${result.moved} ${result.moved === 1 ? 'file' : 'files'} into ${completedDirectories.size} ${completedDirectories.size === 1 ? 'folder' : 'folders'}.`);
  return result;
}
