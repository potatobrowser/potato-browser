/** Trusted scriptlets: pure helpers shared with the iOS app (no Node or Electron imports). */

/** Names (and aliases) of scriptlets uBlock Origin marks `requiresTrust`, with and without `.js`. */
export function trustedScriptletNames(resourcesJson: string): Set<string> {
  const names = new Set<string>();
  try {
    for (const s of JSON.parse(resourcesJson).scriptlets ?? []) {
      if (s?.requiresTrust !== true) continue;
      for (const n of [s.name, ...(s.aliases ?? [])]) {
        if (typeof n !== 'string') continue;
        names.add(n);
        names.add(n.replace(/\.js$/, ''));
      }
    }
  } catch {}
  return names;
}

const SCRIPTLET_NAME = /#@?#\+js\(\s*([^,)\s]+)|#@?%#\/\/scriptlet\(\s*['"]([^'"]+)/;

/**
 * Drops filters that call trusted scriptlets (which can run arbitrary code in pages). Ghostery's
 * engine does not enforce uBlock's trust flag, so, as in uBlock Origin, only uBlock's own lists
 * and the user's filters may use them.
 */
export function dropTrustedScriptlets(text: string, trusted: Set<string>): string {
  if (!trusted.size || !text.includes('+js(') && !text.includes('//scriptlet(')) return text;
  return text
    .split('\n')
    .filter((line) => {
      const m = SCRIPTLET_NAME.exec(line);
      const name = m && (m[1] ?? m[2]);
      return !name || !trusted.has(name.replace(/^['"]|['"]$/g, ''));
    })
    .join('\n');
}
