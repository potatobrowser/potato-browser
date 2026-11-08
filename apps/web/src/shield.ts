import type { ShieldRulesEnvelope } from '@potato/shared';
import { json } from './http';
// Written by scripts/shield-rules.mjs from apps/browser/src/content/shield/rules.ts, signed at deploy.
import generated from './generated/shield-rules.json';

const rules = generated as { version: number; hash: string; payload: string; signature: string };

export function shieldInfo(): { version: number; hash: string } {
  return { version: rules.version, hash: rules.hash };
}

/** GET /api/v1/shield/rules: the signed catalog. The apps check the signature, not this server. */
export function shieldRules(): Response {
  const body: ShieldRulesEnvelope = { payload: rules.payload, signature: rules.signature };
  return json(body, 200, { 'cache-control': 'public, max-age=300' });
}
