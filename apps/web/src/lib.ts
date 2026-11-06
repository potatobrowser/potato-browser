/** Flags one install may add per rolling day. */
export const DAILY_FLAG_CAP = 300;

const hmacKeys = new Map<string, Promise<CryptoKey>>();

/** Voter id = HMAC(secret, install id): stable per install, useless without the secret. */
export async function voterId(secret: string, client: string): Promise<string> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, key);
  }
  const sig = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(client));
  return Array.from(new Uint8Array(sig).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The network an address belongs to: IPv4 /24 or IPv6 /48. */
export function networkPrefix(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}`;
  if (!ip.includes(':')) return ip;
  const [head = '', tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups
    .slice(0, 3)
    .map((g) => (parseInt(g || '0', 16) || 0).toString(16))
    .join(':');
}

/** 16-bit keyed bucket of the voter's network; collapses votes from one network per post. */
export async function networkBucket(secret: string, ip: string): Promise<string> {
  return (await voterId(secret, `net:${networkPrefix(ip)}`)).slice(0, 4);
}
