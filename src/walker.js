import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { directoryChain, assertDirectories, issue, mapLimit } from './utils.js';

export async function walkDirectory(directory, {
  recursive = true, concurrency = 16, maxDepth = 64, maxEntries = Infinity,
  lstatFile = lstat, readDirectory = readdir, onEntry = () => {},
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new RangeError('Traversal concurrency must be between 1 and 32.');
  if ((maxEntries !== Infinity && (!Number.isInteger(maxEntries) || maxEntries < 1)) || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 128) throw new RangeError('Invalid directory traversal limits.');
  const root = path.resolve(directory);
  const parents = await directoryChain(root);
  const errors = [];
  let count = 0, limitReached = false;
  const sameDirectory = (stat, expected) => stat.isDirectory() && stat.dev === expected.device && stat.ino === expected.inode;

  async function visit(handle, original, currentParents, depth) {
    // Child lookups stay relative to a pinned Linux directory handle, including
    // when an ancestor is renamed. Each child is opened without following links.
    const anchored = `/proc/self/fd/${handle.fd}`;
    const names = await readDirectory(anchored);
    if (count + names.length > maxEntries) {
      limitReached = true;
      throw new Error(`Directory entry limit (${maxEntries}) reached; scan incomplete.`);
    }
    count += names.length;
    const directories = [];
    for (let offset = 0; offset < names.length; offset += concurrency) {
      const batch = await mapLimit(names.slice(offset, offset + concurrency), concurrency, async name => {
        try { return { name, stat: await lstatFile(path.join(anchored, name)) }; }
        catch (error) { errors.push(issue(path.join(original, name), error)); return null; }
      });
      for (const entry of batch.filter(Boolean)) {
        onEntry(path.join(original, entry.name), entry.stat, currentParents);
        if (recursive && entry.stat.isDirectory()) directories.push(entry);
      }
    }
    for (const { name, stat } of directories) {
      if (limitReached) break;
      const childPath = path.join(original, name);
      let child;
      try {
        if (depth >= maxDepth) throw new Error(`Directory depth limit (${maxDepth}) reached; scan incomplete.`);
        const target = path.join(anchored, name);
        const expected = { path: childPath, device: stat.dev, inode: stat.ino };
        child = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (!sameDirectory(await child.stat(), expected)) throw new Error('Directory changed during traversal; scan again.');
        await visit(child, childPath, [...currentParents, expected], depth + 1);
        if (!sameDirectory(await lstatFile(target), expected)) throw new Error('Directory changed during traversal; scan again.');
      } catch (error) { errors.push(issue(childPath, error)); }
      finally { if (child) await child.close(); }
    }
  }

  let handle;
  try {
    await assertDirectories(parents);
    handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!sameDirectory(await handle.stat(), parents.at(-1))) throw new Error('Directory changed before traversal; scan again.');
    await visit(handle, root, parents, 0);
    await assertDirectories(parents);
  } catch (error) { errors.push(issue(root, error)); }
  finally { if (handle) await handle.close(); }
  return { root, parents, errors, complete: !errors.length };
}
