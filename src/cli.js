import { parseArgs } from './args.js';
import { readFile } from 'node:fs/promises';

export const HELP = `DupNest — Organize files. Remove duplicates. Reclaim disk space.

Usage:
  dupnest scan [path]       Report exact duplicates and numbered versions
  dupnest clean [path]      Interactively review and move unwanted files to Trash
  dupnest organize [path]   Review category totals and approve organization
  dupnest tidy [path]       Scan, review cleanup, then organize remaining files
  dupnest dev scan          Inspect developer storage (read-only)
  dupnest dev clean         Select and confirm supported cache maintenance

Options:
  --recursive   Scan nested directories; organization stays top-level only
  --dry-run     Read-only preview; no cleanup, rename, or directory creation
  --verbose     Show scan matches, moves, full developer inventory and tool logs
  --help, -h    Show help
  --version     Show version
  --            End options (for paths beginning with a hyphen)

Default path: ~/Downloads. Linux only. Node.js 24+ (26 LTS recommended).
Mutating commands require an interactive terminal and explicit confirmation.
Trash retains disk space until emptied separately. DupNest never empties it.
`;

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.command === 'help') { console.log(HELP); return 0; }
    if (args.command === 'version') {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(pkg.version);
      return 0;
    }
    if (process.platform !== 'linux') throw new Error('DupNest V1 supports Linux only.');
    const { runCommand } = await import('./workflows.js');
    return await runCommand(args);
  } catch (error) {
    console.error(`DupNest: ${String(error.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ' )}`);
    return 1;
  }
}
