import { constants } from 'node:fs';
import { link, unlink, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { assertDirectories, directoryChain, hashFile, metadata, validateFile, displayPath } from './utils.js';

async function verifySource(file) {
  await assertDirectories(file.parents);
  const stat = await lstat(file.path);
  // Our hard link changes ctime and nlink, so compare the remaining identity.
  if (!stat.isFile() || stat.dev !== file.device || stat.ino !== file.inode || stat.size !== file.size || stat.mtimeMs !== file.modifiedMs) {
    throw new Error(`Source changed during move; original preserved: ${displayPath(file.path)}`);
  }
}

async function copyExclusive(file, destination) {
  await validateFile(file);
  const source = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.dev !== file.device || stat.ino !== file.inode || stat.ctimeMs !== file.changedMs) throw new Error('Source changed before copy; scan again.');
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.mode & 0o777);
    for await (const chunk of source.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Copy made no progress.');
        offset += bytesWritten;
      }
    }
    await output.chmod(file.mode & 0o777);
    await output.utimes(file.accessedAt ?? file.modifiedAt, file.modifiedAt);
    await output.sync();
  } finally {
    if (output) await output.close();
    await source.close();
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

// link() and O_EXCL are atomic no-replace operations. rename() alone would
// overwrite an existing destination on Linux, even after an existence check.
export async function moveNoReplace(file, destination, { linkFile = link, copy = copyExclusive, unlinkFile = unlink } = {}) {
  if (destination === file.path) return;
  const destinationParents = await directoryChain(path.dirname(destination));
  const expectedHash = await hashFile(file);
  await validateFile(file);
  await assertDirectories(destinationParents);
  let created = false;
  try {
    try { await linkFile(file.path, destination); created = true; }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await copy(file, destination);
      created = true;
    }
    await assertDirectories(destinationParents);
    const target = metadata(destination, await lstat(destination), destinationParents);
    if (await hashFile(target) !== expectedHash) throw new Error('Destination verification failed.');
    await verifySource(file);
    const currentSource = metadata(file.path, await lstat(file.path), file.parents);
    if (await hashFile(currentSource) !== expectedHash) throw new Error('Source content changed during move.');
    await assertDirectories(destinationParents);
    await validateFile(target);
    await verifySource(file);
    await syncDirectory(path.dirname(destination));
    await unlinkFile(file.path);
  } catch (error) {
    throw new Error(`${error.message}${created ? ` Destination retained at ${displayPath(destination)}; check both paths.` : ` No move completed; check for a partial copy at ${displayPath(destination)}.`}`, { cause: error });
  }
}
