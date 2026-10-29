import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export function resolvePath(input = '~/Downloads', home = os.homedir()) {
  if (input === '~') input = home;
  else if (input.startsWith('~/')) input = path.join(home, input.slice(2));
  else if (input.startsWith('~')) throw new Error('Only ~ and ~/ paths are supported; use an absolute path for other users.');
  return path.resolve(input);
}

// Quote untrusted filenames, including terminal escape sequences and newlines.
export const displayPath = value => JSON.stringify(String(value)).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
export const issue = (target, error) => ({ path: target, message: error.message, code: error.code });
export const inodeKey = file => `${file.device}:${file.inode}`;

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return 'unknown';
  if (bytes === 0) return '0 B';
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

export function metadata(filePath, stat, parents) {
  return {
    path: filePath, name: path.basename(filePath), extension: path.extname(filePath).toLowerCase(),
    size: stat.size, modifiedAt: stat.mtime, modifiedMs: stat.mtimeMs,
    changedMs: stat.ctimeMs, device: stat.dev, inode: stat.ino,
    links: stat.nlink, blocks: stat.blocks, mode: stat.mode, accessedAt: stat.atime, parents,
  };
}

export async function directoryChain(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const paths = [root];
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) paths.push(path.join(paths.at(-1), part));
  const result = [];
  for (const current of paths) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a real directory (symlinks are skipped): ${displayPath(current)}`);
    result.push({ path: current, device: stat.dev, inode: stat.ino });
  }
  return result;
}

export async function assertDirectories(parents) {
  for (const parent of parents) {
    const stat = await lstat(parent.path);
    if (!stat.isDirectory() || stat.dev !== parent.device || stat.ino !== parent.inode) {
      throw new Error(`Directory changed or became a symlink; scan again: ${displayPath(parent.path)}`);
    }
  }
}

function matches(file, stat) {
  return stat.isFile() && stat.dev === file.device && stat.ino === file.inode &&
    stat.size === file.size && stat.mtimeMs === file.modifiedMs && stat.ctimeMs === file.changedMs && stat.nlink === file.links;
}

export async function validateFile(file) {
  await assertDirectories(file.parents);
  const stat = await lstat(file.path);
  if (!matches(file, stat)) throw new Error(`File changed; scan again: ${displayPath(file.path)}`);
  return stat;
}

export async function hashFile(file) {
  await validateFile(file);
  // O_NONBLOCK also prevents a concurrent replacement with a FIFO from hanging.
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!matches(file, await handle.stat())) throw new Error(`File changed before hashing: ${displayPath(file.path)}`);
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) hash.update(chunk);
    if (!matches(file, await handle.stat())) throw new Error(`File changed while hashing: ${displayPath(file.path)}`);
    await validateFile(file);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Concurrency must be an integer from 1 to 32.');
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

export function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return [...groups.values()];
}

export async function exists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
