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
