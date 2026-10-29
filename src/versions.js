import path from 'node:path';
import { groupBy } from './utils.js';
import { hashCandidates } from './duplicates.js';

export function normalizeName(name) {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return stem.replace(/ \(\d+\)$/, '') + extension;
}

export function suggestCandidate(files) {
  return files.reduce((best, file) => !best || file.modifiedMs > best.modifiedMs || (file.modifiedMs === best.modifiedMs && file.path.localeCompare(best.path) < 0) ? file : best, undefined);
}

export async function findVersions(files, options = {}) {
  // Numbered copies from unrelated directories are not evidence of versions.
  const candidates = groupBy(files, f => JSON.stringify([path.dirname(f.path), normalizeName(f.name)]))
    .filter(group => group.length > 1 && group.some(f => normalizeName(f.name) !== f.name));
  const { hashes, errors } = await hashCandidates(candidates.flat(), options);
  return {
    groups: candidates.map(files => {
      const known = files.every(file => hashes.get(file.path));
      const exact = known && new Set(files.map(file => hashes.get(file.path))).size === 1;
      return { kind: exact ? 'exact' : known ? 'versions' : 'uncertain', files, suggested: suggestCandidate(files) };
    }), hashes, errors,
  };
}

// Connected components make review groups disjoint even when exact duplicates
// bridge multiple version families. Every path is approved at most once.
export function buildReviewGroups(duplicates, versions, hashes) {
  const parents = new Map(), sizes = new Map(), byPath = new Map();
  function root(key) {
    let current = key;
    while (parents.get(current) !== current) current = parents.get(current);
    while (key !== current) { const next = parents.get(key); parents.set(key, current); key = next; }
    return current;
  }
  for (const group of [...duplicates, ...versions]) {
    for (const file of group.files) {
      if (!parents.has(file.path)) { parents.set(file.path, file.path); sizes.set(file.path, 1); byPath.set(file.path, file); }
    }
    if (!group.files.length) continue;
    for (const file of group.files.slice(1)) {
      let a = root(group.files[0].path), b = root(file.path);
      if (a === b) continue;
      if (sizes.get(a) < sizes.get(b)) [a, b] = [b, a];
      parents.set(b, a);
      sizes.set(a, sizes.get(a) + sizes.get(b));
    }
  }
  return groupBy([...byPath.values()], file => root(file.path)).map(members => {
    const files = members.sort((a, b) => a.path.localeCompare(b.path));
    const known = files.every(file => hashes.get(file.path));
    const exact = known && new Set(files.map(file => hashes.get(file.path))).size === 1;
    return { files, kind: exact ? 'exact' : known ? 'versions' : 'uncertain', suggested: suggestCandidate(files) };
  });
}
