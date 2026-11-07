/**
 * The ad blocker's WebKit rule lists, one per list group. Used by the build (the lists the app
 * ships) and on the device (daily list updates, the user's own filters).
 */
import { assemble, collectBadfilters, convertLists, IOS_ENV, type ConvertStats, type WebKitRule } from './contentblocker';

export interface GroupLists {
  id: string;
  /** Raw list texts. */
  lists: string[];
}

export interface BuiltRuleList {
  rules: WebKitRule[];
  stats: ConvertStats;
}

/**
 * Exceptions of the ads group (uBlock's unbreak and quick fixes among them) and of the user's
 * own filters also apply to every other group's list, as they would in uBlock Origin.
 */
export function buildRuleLists(groups: GroupLists[], custom = '', env = IOS_ENV): Record<string, BuiltRuleList> {
  const texts = [...groups.flatMap((g) => g.lists), custom];
  const badfilters = collectBadfilters(texts, env);
  const converted = groups.map((g) => ({ id: g.id, ...convertLists(g.lists, { env, badfilters }) }));
  const user = custom.trim() ? convertLists([custom], { env, badfilters }) : null;
  const ads = converted.find((c) => c.id === 'ads');
  const userExceptions = user ? user.converted.exceptions : [];
  const out: Record<string, BuiltRuleList> = {};
  for (const c of converted) {
    const extra = [...(c.id === 'ads' || !ads ? [] : ads.converted.exceptions), ...userExceptions];
    out[c.id] = { rules: assemble(c.converted, extra), stats: c.stats };
  }
  if (user) {
    const extra = ads ? ads.converted.exceptions : [];
    out.custom = { rules: assemble(user.converted, extra), stats: user.stats };
  }
  return out;
}
