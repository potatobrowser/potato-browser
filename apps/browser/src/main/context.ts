import type { AdblockService } from './adblock/service';
import type { ProfileDb } from './db';
import type { SettingsStore } from './settings';
import type { WindowManager } from './windows';
import type { DownloadManager } from './downloads';
import type { PermissionManager } from './permissions';
import type { ShieldService } from './shield';
import type { FlagsService } from './flags';
import type { PasswordService } from './passwords/service';
import type { UpdateChecker } from './updates';

/** Process-wide services, filled in once at startup (see index.ts). */
export interface AppContext {
  settings: SettingsStore;
  db: ProfileDb;
  windows: WindowManager;
  downloads: DownloadManager;
  permissions: PermissionManager;
  shield: ShieldService;
  adblock: AdblockService;
  flags: FlagsService;
  passwords: PasswordService;
  updates: UpdateChecker;
}

export const ctx = {} as AppContext;
