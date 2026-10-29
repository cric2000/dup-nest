import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function fixture(t, entries = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dupnest-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

export function fakeUI(answers = [], interactive = true) {
  const output = [];
  return {
    interactive, output,
    print: message => output.push(message),
    ask: async prompt => { output.push(prompt); if (!answers.length) throw new Error('Input unavailable.'); return answers.shift(); },
    confirm: async function (prompt) { return /^(y|yes)$/i.test((await this.ask(`${prompt} [y/N]: `)).trim()); },
  };
}
