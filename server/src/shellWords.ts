/** Shared argv-parsing helpers for CLI launch providers (claude, antigravity). */

/** A program's bare name: `/usr/local/bin/claude`, `claude.cmd` → `claude`. */
export function programBase(program: string): string {
  // Either separator: a Windows path must name its program on any host.
  return (program.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
}

/** Value of a flag among argv args, honoring `--flag value` and `--flag=value`. */
export function flagValue(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) {
        const next = args[i + 1];
        return next !== undefined && !next.startsWith('-') ? next : '';
      }
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return undefined;
}
