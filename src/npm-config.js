import { realpath, open } from 'node:fs/promises';
import { runProcess } from './process.js';

export async function readNpmCachePath(executable, { run = runProcess, env = process.env } = {}) {
  const script = await realpath(executable);
  const handle = await open(script, 'r');
  let header;
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
  if (!/^#![^\n]*\bnode\b/.test(header)) throw new Error('npm is not a recognizable Node CLI script; cache discovery unavailable without a safe read-only query.');
  // npm creates its cache root even with logging disabled. Node's permission
  // model denies writes and subprocess creation while configuration loads.
  const result = await run(process.execPath, ['--permission', '--allow-fs-read=*', script, 'config', 'get', 'cache'], {
    env: { ...env, NODE_OPTIONS: '', npm_config_timing: 'false' },
  });
  if (!result.ok) throw new Error(result.stderr || result.error || 'Read-only npm configuration query failed.');
  return result.stdout;
}
