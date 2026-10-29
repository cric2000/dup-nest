import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function readSettings(filename) {
  if (!filename) return {};
  let text;
  try { text = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const values = {};
  // go env -w stores literal KEY=value lines, not executable shell syntax.
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export async function readGoCachePaths(executable, env = process.env) {
  const home = env.HOME || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const envFile = env.GOENV === 'off' ? null : env.GOENV || path.join(configHome, 'go', 'env');
  if (envFile && !path.isAbsolute(envFile)) throw new Error('GOENV must identify an absolute config path for safe inspection.');
  const user = await readSettings(envFile);
  const binary = await realpath(executable);
  const root = env.GOROOT || user.GOROOT || (path.basename(path.dirname(binary)) === 'bin' ? path.dirname(path.dirname(binary)) : null);
  const system = await readSettings(root ? path.join(root, 'go.env') : null);
  const value = key => env[key] || (Object.hasOwn(user, key) ? user[key] : system[key]) || '';
  const cacheHome = env.XDG_CACHE_HOME || path.join(home, '.cache');
  const gopath = value('GOPATH') || path.join(home, 'go');
  const moduleRoot = gopath.split(path.delimiter).find(Boolean);
  return {
    GOCACHE: value('GOCACHE') || path.join(cacheHome, 'go-build'),
    GOMODCACHE: value('GOMODCACHE') || (moduleRoot ? path.join(moduleRoot, 'pkg', 'mod') : ''),
    GOCACHEPROG: value('GOCACHEPROG'),
  };
}
