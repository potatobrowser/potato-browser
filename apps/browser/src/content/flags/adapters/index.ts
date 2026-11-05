import { hostMatchesPattern } from '../../shield/match';
import type { FlagAdapter } from '../types';
import { bluesky } from './bluesky';
import { facebook } from './facebook';
import { instagram } from './instagram';
import { linkedin } from './linkedin';
import { reddit } from './reddit';
import { threads } from './threads';
import { tiktok } from './tiktok';
import { x } from './x';
import { youtube } from './youtube';

export const ADAPTERS: FlagAdapter[] = [reddit, x, instagram, facebook, threads, linkedin, youtube, tiktok, bluesky];

export function adapterFor(host: string): FlagAdapter | null {
  return ADAPTERS.find((a) => a.hosts.some((p) => hostMatchesPattern(host, p))) ?? null;
}
