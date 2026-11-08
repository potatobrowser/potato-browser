import crypto from 'node:crypto';
import { SHIELD_RULES_FORMAT, SHIELD_RULES_KEYS, type ShieldRulesEnvelope, type ShieldRulesPayload } from '@potato/shared';
import type { ShieldRule } from '../content/shield/types';
import { validateRules } from '../content/shield/validate';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Ed25519 public keys (raw, base64) as key objects; tests may bring their own. */
export function publicKeys(raw: string[] = process.env.POTATO_TEST === '1' && process.env.POTATO_SHIELD_KEYS ? process.env.POTATO_SHIELD_KEYS.split(',') : SHIELD_RULES_KEYS): crypto.KeyObject[] {
  return raw.flatMap((k) => {
    try {
      return [crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(k.trim(), 'base64')]), format: 'der', type: 'spki' })];
    } catch {
      return [];
    }
  });
}

/** A rule update whose signature checks out and whose rules are well-formed, or null. */
export function openRules(envelope: unknown, keys = publicKeys()): { rules: ShieldRule[]; version: number; hash: string } | null {
  const e = envelope as Partial<ShieldRulesEnvelope> | null;
  if (!e || typeof e.payload !== 'string' || typeof e.signature !== 'string' || e.payload.length > 2_000_000) return null;
  const data = Buffer.from(e.payload);
  const sig = Buffer.from(e.signature, 'base64');
  if (sig.length !== 64 || !keys.some((k) => crypto.verify(null, data, k, sig))) return null;
  let p: ShieldRulesPayload;
  try {
    p = JSON.parse(e.payload);
  } catch {
    return null;
  }
  if (p.format !== SHIELD_RULES_FORMAT || !Number.isSafeInteger(p.version) || typeof p.hash !== 'string' || !/^[0-9a-f]{64}$/.test(p.hash)) return null;
  const rules = validateRules(p.rules);
  return rules ? { rules, version: p.version, hash: p.hash } : null;
}
