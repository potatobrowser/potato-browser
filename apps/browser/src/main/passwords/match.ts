import { getDomain } from 'tldts-experimental';

/** `https://example.com` (or with a port) for http(s) URLs; null for anything else. */
export function normalizeOrigin(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  // Password managers often store bare hosts ("example.com/login", "localhost:3000").
  const bare = !s.includes('://');
  if (bare) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // "mailto:a@b.test" read as a bare host would be user "mailto" at b.test.
    if (bare && (u.username || u.password)) return null;
    return u.hostname ? u.origin : null;
  } catch {
    return null;
  }
}

export function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/**
 * The registrable domain, with private suffixes (github.io, blogspot.com) counted as public so
 * two people's sites there never share passwords. IPs and single-label hosts stand alone.
 */
export function siteOfOrigin(origin: string): string {
  const host = hostOfOrigin(origin);
  return host ? registrableDomain(host) || host : '';
}

function registrableDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true });
}

export type MatchKind = 'exact' | 'site';

/**
 * How a login saved for `saved` applies to a frame of `page`. Exact: same origin, or the same
 * host upgraded from http to https. Site: same registrable domain. A password saved on https is
 * never offered to an http page.
 */
export function matchKind(saved: string, page: string): MatchKind | null {
  let s: URL;
  let p: URL;
  try {
    s = new URL(saved);
    p = new URL(page);
  } catch {
    return null;
  }
  if (p.protocol === 'http:' && s.protocol === 'https:') return null;
  if (s.protocol !== 'https:' && s.protocol !== 'http:') return null;
  if (p.protocol !== 'https:' && p.protocol !== 'http:') return null;
  if (s.origin === p.origin) return 'exact';
  // URL leaves the port empty when it is the scheme's default.
  if (s.hostname === p.hostname && s.protocol === 'http:' && p.protocol === 'https:' && !s.port && !p.port) return 'exact';
  // IP addresses and hosts like "localhost" have no registrable domain and only match themselves.
  const site = registrableDomain(s.hostname);
  return site && site === registrableDomain(p.hostname) && s.port === p.port ? 'site' : null;
}

/** How the password to save is picked from a form's password fields, in page order. */
export interface PasswordFieldValue {
  value: string;
  /** The field's autocomplete attribute, lowercased. */
  autocomplete: string;
}

/**
 * Login: one field. Sign-up: new and confirmation are equal. Change: current, new and its
 * confirmation, or fields marked new-password. Returns null when the fields do not tell which
 * one is the new password.
 */
export function pickPasswords(fields: PasswordFieldValue[]): { password: string; current: string | null } | null {
  const filled = fields.filter((f) => f.value);
  if (!filled.length) return null;
  const marked = filled.find((f) => f.autocomplete.includes('new-password'));
  if (marked) {
    const current = filled.find((f) => f.autocomplete.includes('current-password'))?.value ?? filled.find((f) => f !== marked && f.value !== marked.value)?.value ?? null;
    return { password: marked.value, current };
  }
  const v = filled.map((f) => f.value);
  if (v.length === 1) return { password: v[0]!, current: null };
  // Two different values without hints may be a password and a PIN on a sign-in form.
  if (v.length === 2) return v[0] === v[1] ? { password: v[0]!, current: null } : null;
  if (v.length === 3) {
    if (v[1] === v[2]) return { password: v[1]!, current: v[0] === v[1] ? null : v[0]! };
    if (v[0] === v[1]) return { password: v[0]!, current: null };
  }
  return null;
}
