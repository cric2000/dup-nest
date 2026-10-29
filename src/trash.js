import { lstat } from 'node:fs/promises';
import { findExecutable, runProcess } from './process.js';
import { validateFile, displayPath } from './utils.js';

export async function createTrash({ find = findExecutable, run = runProcess } = {}) {
  const gio = await find('gio');
  if (!gio) throw new Error('Linux Trash is unavailable: install gio (Ubuntu: libglib2.0-bin). No files were trashed.');
  return async function trash(file) {
    await validateFile(file);
    const result = await run(gio, ['trash', '--', file.path]);
    if (!result.ok) throw new Error(`Trash failed for ${displayPath(file.path)}: ${result.stderr || result.error}. No permanent-deletion fallback was used; check the source and Trash.`);
    try {
      await lstat(file.path);
      throw new Error(`Trash command returned success but the source still exists: ${displayPath(file.path)}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
