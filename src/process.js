import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const execute = promisify(execFile);

export async function findExecutable(name, env = process.env) {
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Continue searching PATH. */ }
  }
  return null;
}

export async function runProcess(command, args, { timeout = 30000, env = process.env, ...options } = {}) {
  try {
    const result = await execute(command, args, {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout, ...options,
      env: { ...env, npm_config_logs_max: '0', npm_config_update_notifier: 'false',
        COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        GOTOOLCHAIN: 'local', YARN_ENABLE_TELEMETRY: '0' }, shell: false,
    });
    return { ok: true, code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, code: error.code, stdout: error.stdout || '', stderr: error.stderr || '',
      error: error.killed ? 'Command timed out; partial changes may have occurred.' : error.message };
  }
}
