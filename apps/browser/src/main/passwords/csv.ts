import { normalizeOrigin } from './match';

/** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes, CRLF or LF, a BOM. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export interface CsvLogin {
  origin: string;
  username: string;
  password: string;
  note: string;
}

export interface CsvRead {
  /** Which app the columns look like it came from, for the result message. */
  source: string | null;
  logins: CsvLogin[];
  skipped: {
    /** Rows without a password. */
    noPassword: number;
    /** Rows without a website address (or one that is not http or https, like Android apps). */
    noWebsite: number;
    /** 1Password items in the archive. */
    archived: number;
    /** The same website and username again in the file. */
    duplicates: number;
  };
}

export class CsvError extends Error {}

/** Header names per field, as Chrome, Safari, Firefox, 1Password, Bitwarden and LastPass write them. */
const COLUMNS = {
  url: ['url', 'website', 'web site', 'login_uri', 'login uri', 'uri', 'urls', 'origin', 'hostname', 'login url', 'address'],
  username: ['username', 'login_username', 'user name', 'login', 'email', 'e-mail', 'user'],
  password: ['password', 'login_password'],
  note: ['note', 'notes', 'extra', 'comments'],
  archived: ['archived'],
} as const;

function detectSource(h: string[]): string | null {
  const has = (n: string) => h.includes(n);
  if (has('httprealm') || has('formactionorigin')) return 'Firefox';
  if (has('login_uri')) return 'Bitwarden';
  if (has('grouping') || has('extra')) return 'LastPass';
  if (has('otpauth') && (has('favorite') || has('archived') || has('tags'))) return '1Password';
  if (has('otpauth')) return 'Safari';
  if (has('name') && has('url') && has('username') && has('password')) return 'Chrome';
  return null;
}

/** Reads a password export. Columns are found by their header names, in any order. */
export function readPasswordCsv(text: string): CsvRead {
  const firstLine = text.slice(0, text.search(/\r|\n|$/));
  const delimiter = !firstLine.includes(',') && firstLine.includes(';') ? ';' : !firstLine.includes(',') && firstLine.includes('\t') ? '\t' : ',';
  const rows = parseCsv(text, delimiter);
  if (!rows.length) throw new CsvError('The file is empty.');
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (names: readonly string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const url = col(COLUMNS.url);
  const username = col(COLUMNS.username);
  const password = col(COLUMNS.password);
  const note = col(COLUMNS.note);
  const archived = col(COLUMNS.archived);
  if (url < 0 || password < 0) {
    throw new CsvError('This does not look like a password export: the first row needs columns named url (or website) and password.');
  }
  const out: CsvRead = { source: detectSource(header), logins: [], skipped: { noPassword: 0, noWebsite: 0, archived: 0, duplicates: 0 } };
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? '') : '');
    if (archived >= 0 && /^(true|yes|1)$/i.test(get(archived).trim())) {
      out.skipped.archived++;
      continue;
    }
    const pw = get(password);
    if (!pw) {
      out.skipped.noPassword++;
      continue;
    }
    // Bitwarden puts several addresses in one cell; the first web one wins.
    const origin = get(url)
      .split(/[\s,]+/)
      .map((u) => (u.includes('://') || /^[\w-]+((\.[\w-]+)+(:\d+)?|:\d+)([/?#]|$)/.test(u) ? normalizeOrigin(u) : null))
      .find((o): o is string => !!o);
    if (!origin) {
      out.skipped.noWebsite++;
      continue;
    }
    const user = get(username).trim();
    const key = `${origin}\n${user}`;
    if (seen.has(key)) {
      out.skipped.duplicates++;
      continue;
    }
    seen.add(key);
    out.logins.push({ origin, username: user, password: pw, note: get(note) });
  }
  return out;
}

/** Chrome's export format, which Chrome, Safari, Firefox and most password managers import. */
export function passwordCsv(logins: { origin: string; username: string; password: string; note: string }[]): string {
  const host = (o: string) => o.replace(/^https?:\/\//, '');
  return toCsv([['name', 'url', 'username', 'password', 'note'], ...logins.map((l) => [host(l.origin), l.origin + '/', l.username, l.password, l.note])]);
}
