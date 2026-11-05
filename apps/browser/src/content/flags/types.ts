import type { Platform } from '@noai/shared';

export interface MountPoint {
  parent: Element;
  /** Insert before this node; append when null/undefined. */
  before?: Node | null;
}

/** Knows one platform's DOM: where posts are, their stable ids, and where the flag button goes. */
export interface FlagAdapter {
  platform: Platform;
  /** Host patterns, same syntax as AI Shield rules. */
  hosts: string[];
  /** All flaggable items (posts and comments) currently in the document. */
  items(root: Document): Element[];
  /**
   * Platform id that is identical wherever the item is shown, or null if not resolvable yet.
   * Several ids (primary first) when a platform shows different ids for one post on different
   * surfaces; flags are written to all of them and lookups take the highest count.
   */
  id(el: Element): string | string[] | null;
  /** Where the flag button goes inside the item. */
  mount(el: Element): MountPoint | null;
  /** Element collapsed in "hide" mode; defaults to the item. */
  hideTarget?(el: Element): Element;
}

export interface FlagStatus {
  n: number;
  mine: boolean;
}

export interface FlagsBridge {
  lookup(keys: string[], localOnly: boolean): Promise<Record<string, FlagStatus>>;
  /** Flags (or un-flags) every key of one post. */
  set(keys: string[], flag: boolean): Promise<Record<string, FlagStatus>>;
  report(r: { platform: Platform; hidden: number; labeled: number }): void;
  insertCSS(css: string): string;
  removeCSS(key: string): void;
}
