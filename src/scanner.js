import path from 'node:path';
import { resolvePath, metadata } from './utils.js';
import { walkDirectory } from './walker.js';

const INCOMPLETE = /\.(?:crdownload|part|partial|download)$/i;

export async function scanDirectory(input, { recursive = false, ...options } = {}) {
  const root = resolvePath(input);
  const files = [];
  let skipped = 0;
  const traversal = await walkDirectory(root, { ...options, recursive, onEntry(filePath, stat, parents) {
    if (stat.isDirectory()) return;
    if (stat.isFile() && !INCOMPLETE.test(path.basename(filePath))) files.push(metadata(filePath, stat, parents));
    else skipped++;
  } });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...traversal, files, skipped };
}
