/**
 * The chat's `/` menu, like the CLI's: while the draft is a lone `/word`,
 * the agent's slash commands that match are offered. Pure helpers (Node
 * runner tested); the list itself comes from the agent's CLI via the server.
 */

/** The text after `/` while the draft is still just a command name, else null. */
export function slashQuery(draft: string): string | null {
  const m = /^\/([\w:.-]*)$/.exec(draft);
  return m ? m[1] : null;
}

/**
 * Commands matching `query`, best first: name starts with it, then a
 * namespaced command's own name starts with it (`caveman:caveman-help` for
 * `cave`… `help`), then it appears anywhere. Case-insensitive.
 */
export function matchCommands(commands: string[], query: string, max: number): string[] {
  const q = query.toLowerCase();
  const rank = (name: string): number => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 0;
    const own = n.includes(':') ? n.slice(n.indexOf(':') + 1) : '';
    if (own.startsWith(q)) return 1;
    return n.includes(q) ? 2 : -1;
  };
  return commands
    .map((name) => ({ name, r: rank(name) }))
    .filter((c) => c.r >= 0)
    .sort((a, b) => a.r - b.r || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((c) => c.name);
}
