import { createInterface } from 'node:readline/promises';
import { displayPath, formatBytes } from './utils.js';

export function createUI(input = process.stdin, output = process.stdout) {
  const interactive = Boolean(input.isTTY && output.isTTY);
  let reader;
  let closed = false;
  const controller = new AbortController();
  return {
    interactive,
    get cancelled() { return closed; },
    print: message => output.write(`${message}\n`),
    async ask(prompt) {
      if (!interactive || closed) throw new Error('Interactive terminal input is required; no further operations were approved.');
      if (!reader) {
        reader = createInterface({ input, output });
        reader.on('close', () => { closed = true; controller.abort(); });
        reader.on('SIGINT', () => { reader.close(); });
      }
      try { return await reader.question(prompt, { signal: controller.signal }); }
      catch { throw new Error('Input ended; no further operations were approved.'); }
    },
    async confirm(prompt) { return /^(y|yes)$/i.test((await this.ask(`${prompt} [y/N]: `)).trim()); },
    close() { reader?.close(); },
  };
}

export function requireInteractive(ui) {
  if (!ui.interactive) throw new Error('This command requires an interactive terminal. Use --dry-run for a read-only preview.');
  if (ui.cancelled) throw new Error('Input ended or was interrupted; no further operations were approved.');
}

export function printFiles(ui, files) {
  files.forEach((file, index) => ui.print(`  ${index + 1}. ${displayPath(file.path)}  ${formatBytes(file.size)}  Modified ${file.modifiedAt.toISOString()}`));
}

export function printErrors(ui, errors) {
  for (const error of errors) ui.print(`Error: ${displayPath(error.path)}: ${displayPath(error.message)}`);
}
