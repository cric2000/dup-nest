export function parseArgs(argv) {
  const options = { recursive: false, dryRun: false, verbose: false };
  const words = [];
  let positional = false;
  for (const arg of argv) {
    if (positional) words.push(arg);
    else if (arg === '--') positional = true;
    else if (arg === '--recursive') options.recursive = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version') options.version = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}. Use --help. Use -- before a path beginning with '-'.`);
    else words.push(arg);
  }
  const [command, next, ...rest] = words;
  if (options.version) {
    if (words.length || options.recursive || options.dryRun || options.verbose || options.help) throw new Error('--version must be used alone.');
    return { command: 'version' };
  }
  if (!command) {
    if (!options.help && (options.recursive || options.dryRun || options.verbose)) throw new Error('Specify a command. Use --help.');
    return { command: 'help' };
  }
  if (command === 'dev') {
    if (options.help && !next) return { command: 'help' };
    if (!['scan', 'clean'].includes(next) || rest.length) throw new Error('Usage: dupnest dev <scan|clean> [--dry-run] [--verbose]');
    if (options.recursive) throw new Error('--recursive is only available for file commands.');
    return { ...options, command: options.help ? 'help' : `dev ${next}` };
  }
  if (!['scan', 'clean', 'organize', 'tidy'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (rest.length) throw new Error('Expected at most one directory path. Quote paths containing spaces.');
  return { ...options, command: options.help ? 'help' : command, path: next };
}
