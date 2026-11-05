import type { ShieldRule } from './types';

const cache = new Map<string, RegExp>();

/** Compiles a host pattern (see ShieldRule.hosts) into a regex. */
export function hostPatternRegex(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (re) return re;
  let p = pattern.toLowerCase().replace(/^www\./, '');
  let prefix = '^(?:www\\.)?';
  if (p.startsWith('*.')) {
    p = p.slice(2);
    prefix = '^(?:[a-z0-9-]+\\.)*';
  }
  const tldWildcard = p.endsWith('.*');
  if (tldWildcard) p = p.slice(0, -2);
  const body = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // "google.*" -> google.com, google.de, google.co.uk, google.com.br
  const suffix = tldWildcard ? '\\.(?:[a-z]{2,3}|co\\.[a-z]{2}|com\\.[a-z]{2})$' : '$';
  re = new RegExp(prefix + body + suffix);
  cache.set(pattern, re);
  return re;
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  return hostPatternRegex(pattern).test(host.toLowerCase());
}

export function ruleMatchesHost(rule: ShieldRule, host: string): boolean {
  return rule.hosts.some((p) => hostMatchesPattern(host, p));
}

export function ruleMatchesPath(rule: ShieldRule, pathname: string): boolean {
  return !rule.paths?.length || rule.paths.some((p) => new RegExp(p).test(pathname));
}
