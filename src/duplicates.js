import { groupBy, mapLimit, hashFile, inodeKey, issue, validateFile } from './utils.js';

export async function hashCandidates(files, { hashes = new Map(), concurrency = 4, hash = hashFile } = {}) {
  const errors = [];
  const pending = groupBy(files.filter(file => !hashes.has(file.path)), file => JSON.stringify([inodeKey(file), file.size, file.modifiedMs, file.changedMs, file.links]));
  await mapLimit(pending, concurrency, async aliases => {
    let digest;
    for (const file of aliases) {
      try {
        // Identical inode snapshots share one streamed hash, but every alias
        // must still name the unchanged regular file before reusing the digest.
        if (digest) await validateFile(file);
        else digest = await hash(file);
        hashes.set(file.path, digest);
      } catch (error) { errors.push(issue(file.path, error)); hashes.set(file.path, null); }
    }
  });
  return { hashes, errors };
}

export function duplicateStorage(files) {
  const inodes = groupBy(files, inodeKey);
  const contained = inodes.filter(group => group[0].links <= group.length);
  // If an inode also has paths outside the group, removing these paths frees no
  // inode storage. Keeping that inode permits all contained copies to be removed.
  const copies = Math.max(0, contained.length - (contained.length === inodes.length ? 1 : 0));
  return { redundantCopies: Math.max(0, inodes.length - 1), potentialBytes: copies * files[0].size };
}

export async function findDuplicates(files, options = {}) {
  const candidates = groupBy(files, f => f.size).filter(group => group.length > 1).flat();
  const { hashes, errors } = await hashCandidates(candidates, options);
  const groups = groupBy(candidates.filter(f => hashes.get(f.path)), f => `${f.size}:${hashes.get(f.path)}`)
    .filter(group => group.length > 1)
    .map(files => ({ kind: 'exact', files, hash: hashes.get(files[0].path), ...duplicateStorage(files) }));
  return {
    groups, hashes, errors,
    potentialBytes: groups.reduce((sum, group) => sum + group.potentialBytes, 0),
    redundantCopies: groups.reduce((sum, group) => sum + group.redundantCopies, 0),
  };
}
