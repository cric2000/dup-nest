import path from 'node:path';
import { createTrash } from './trash.js';
import { hashFile, validateFile, exists, issue, displayPath, mapLimit } from './utils.js';
import { moveNoReplace } from './move.js';
import { requireInteractive, printFiles, printErrors } from './ui.js';

export function validateRename(name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || name !== path.basename(name)) throw new Error('Rename requires a filename only, without directory components.');
  return name;
}

export async function cleanGroups(groups, hashes, ui, { dryRun = false, verbose = false, trashFactory = createTrash, move = moveNoReplace, hash = hashFile } = {}) {
  const result = { trashed: 0, renamed: 0, skipped: 0, errors: [], trashedBytes: 0 };
  let trash;
  if (!dryRun) requireInteractive(ui);
  for (const group of groups) {
    ui.print(`\n${group.kind === 'exact' ? 'Exact duplicate copies (identical bytes)' : group.kind === 'uncertain' ? 'Uncertain group: unreadable or changed files' : 'Possible versions (different content; may include exact copies)'}`);
    printFiles(ui, group.files);
    ui.print(`Suggested review candidate: ${displayPath(group.suggested.path)} (most recently modified; timestamps do not prove content freshness).`);
    if (group.kind === 'uncertain') { ui.print('Cleanup unavailable for this group; resolve errors and scan again.'); result.skipped++; continue; }
    if (dryRun) {
      ui.print('Preview: choose one file to KEEP, optionally RENAME it to an unused name, and move the other listed paths to Trash only after confirmation. No selection or mutation performed.');
      continue;
    }
    let choice;
    while (true) {
      choice = (await ui.ask(`Keep which file? [1-${group.files.length}, a=keep all, s=skip; default s]: `)).trim().toLowerCase();
      if (!choice || ['a', 's'].includes(choice) || (/^[1-9]\d*$/.test(choice) && Number(choice) <= group.files.length)) break;
      ui.print('Enter a listed number, a, or s.');
    }
    if (!choice || ['a', 's'].includes(choice)) { result.skipped++; continue; }
    const keep = group.files[Number(choice) - 1];
    const discard = group.files.filter(file => file !== keep);
    const rename = (await ui.ask('Optional new filename for retained file (Enter to keep its name): ')).trim();
    let destination;
    try {
      if (rename && rename !== keep.name) {
        destination = path.join(path.dirname(keep.path), validateRename(rename));
        if (await exists(destination)) throw new Error('Rename destination exists; choose an unused filename on a new review.');
      }
    } catch (error) { result.errors.push(issue(keep.path, error)); ui.print(error.message); continue; }
    ui.print(`\nKEEP: ${displayPath(keep.path)}`);
    if (destination) ui.print(`RENAME: ${displayPath(keep.path)} -> ${displayPath(destination)}`);
    for (const file of discard) ui.print(`MOVE TO TRASH: ${displayPath(file.path)}`);
    if (group.kind !== 'exact') ui.print('Warning: these files contain different bytes. Review their contents yourself before discarding versions.');
    ui.print('Trash does not free disk space until emptied separately.');
    if (!await ui.confirm('Proceed with these operations?')) { result.skipped++; continue; }
    const previouslyTrashed = result.trashed, previouslyRenamed = result.renamed;
    try {
      // Validate the entire approved group before the first operation.
      const checks = await mapLimit(group.files, 4, async file => {
        try {
          if (!hashes.get(file.path) || await hash(file) !== hashes.get(file.path)) throw new Error(`Content changed; scan again: ${displayPath(file.path)}`);
          return null;
        } catch (error) { return error; }
      });
      const changed = checks.find(Boolean);
      if (changed) throw changed;
      if (destination && await exists(destination)) throw new Error('Rename destination now exists; scan again.');
      trash ||= await trashFactory();
      for (const file of discard) {
        requireInteractive(ui);
        // The group was just rehashed. Identity, ctime, size and mtime checks
        // now detect changes without rereading the retained bytes for each copy.
        await validateFile(keep);
        await validateFile(file);
        requireInteractive(ui);
        await trash(file);
        result.trashed++;
        result.trashedBytes += file.size;
        if (verbose) ui.print(`Moved to Trash: ${displayPath(file.path)}`);
      }
      if (destination) { requireInteractive(ui); await move(keep, destination); result.renamed++; ui.print(`Renamed retained file: ${displayPath(destination)}`); }
    } catch (error) {
      result.errors.push(issue(keep.path, error));
      ui.print('This group stopped. Previously completed operations remain completed.');
      printErrors(ui, [result.errors.at(-1)]);
    }
    const trashed = result.trashed - previouslyTrashed, renamed = result.renamed - previouslyRenamed;
    ui.print(`Group result: ${trashed} ${trashed === 1 ? 'file' : 'files'} moved to Trash; ${renamed} retained ${renamed === 1 ? 'file' : 'files'} renamed.`);
  }
  return result;
}
