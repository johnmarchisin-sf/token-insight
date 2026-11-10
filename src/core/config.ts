// Persistent user config for token-insight: stored in ~/.token-insight.json,
// auto-created with defaults, atomically written to survive crashes/races.
//
// The cluster denylist is the only persisted state today; the file is shaped
// to grow (future: user-defined workspace aliases, threshold overrides).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ProfileName,
  DEFAULT_PROFILE,
  isValidProfileName,
  setActiveProfileSettings,
  mergeProfile,
} from './profile.js';

export interface DenylistEntry {
  id: string;
  reason: 'denied' | 'created';
  repExcerpt: string;
  trigrams: string[];
  addedAt: string; // ISO timestamp
}

export interface TokenInsightConfig {
  clusterDenylist: DenylistEntry[];
  profile: ProfileName;
  /** Extra top-level dirs to bucket workspaces by, on top of the profile preset. */
  customKnownBuckets: string[];
  /** Extra deep-rollup buckets to merge with the profile preset. */
  customDeepRollupBuckets: Record<string, string[]>;
}

const DEFAULT_CONFIG: TokenInsightConfig = {
  clusterDenylist: [],
  profile: DEFAULT_PROFILE,
  customKnownBuckets: [],
  customDeepRollupBuckets: {},
};

function configPath(): string {
  return path.join(os.homedir(), '.token-insight.json');
}

let cache: TokenInsightConfig | null = null;

function clone(c: TokenInsightConfig): TokenInsightConfig {
  return JSON.parse(JSON.stringify(c));
}

function normalize(parsed: unknown): TokenInsightConfig {
  if (!parsed || typeof parsed !== 'object') return clone(DEFAULT_CONFIG);
  const obj = parsed as Record<string, unknown>;
  const dl = Array.isArray(obj.clusterDenylist) ? obj.clusterDenylist : [];
  const clean: DenylistEntry[] = [];
  for (const e of dl) {
    if (
      e &&
      typeof e === 'object' &&
      typeof (e as any).id === 'string' &&
      ((e as any).reason === 'denied' || (e as any).reason === 'created') &&
      typeof (e as any).repExcerpt === 'string' &&
      Array.isArray((e as any).trigrams) &&
      typeof (e as any).addedAt === 'string'
    ) {
      clean.push({
        id: (e as any).id,
        reason: (e as any).reason,
        repExcerpt: (e as any).repExcerpt,
        trigrams: ((e as any).trigrams as unknown[]).filter((t): t is string => typeof t === 'string'),
        addedAt: (e as any).addedAt,
      });
    }
  }
  const profileRaw = obj.profile;
  const profile: ProfileName =
    typeof profileRaw === 'string' && isValidProfileName(profileRaw)
      ? profileRaw
      : DEFAULT_PROFILE;

  const customKnownBuckets = Array.isArray(obj.customKnownBuckets)
    ? (obj.customKnownBuckets as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  const customDeepRollupBuckets: Record<string, string[]> = {};
  if (obj.customDeepRollupBuckets && typeof obj.customDeepRollupBuckets === 'object') {
    for (const [k, v] of Object.entries(obj.customDeepRollupBuckets as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const subs = v.filter((s): s is string => typeof s === 'string');
        if (subs.length > 0) customDeepRollupBuckets[k] = subs;
      }
    }
  }
  return { clusterDenylist: clean, profile, customKnownBuckets, customDeepRollupBuckets };
}

function applyEffectiveProfile(c: TokenInsightConfig): void {
  setActiveProfileSettings(
    mergeProfile(c.profile, {
      knownBuckets: c.customKnownBuckets,
      deepRollupBuckets: c.customDeepRollupBuckets,
    })
  );
}

/**
 * Load the persisted profile and apply it (merged with user overrides) as the
 * active profile. Called once at startup before any command dispatches.
 */
export async function initProfile(): Promise<ProfileName> {
  const c = await loadConfig();
  applyEffectiveProfile(c);
  return c.profile;
}

export async function setProfile(name: ProfileName): Promise<void> {
  const c = await loadConfig();
  c.profile = name;
  await saveConfig(c);
  applyEffectiveProfile(c);
}

export async function loadConfig(): Promise<TokenInsightConfig> {
  if (cache) return clone(cache);
  let parsed: unknown = null;
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    parsed = JSON.parse(raw);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // Malformed JSON or read error: fall back to defaults rather than crashing.
      // We do not overwrite the corrupt file automatically.
      process.stderr.write(`[token-insight] config read error, using defaults: ${err.message}\n`);
    }
  }
  cache = normalize(parsed);
  return clone(cache);
}

export async function saveConfig(c: TokenInsightConfig): Promise<void> {
  const target = configPath();
  const tmp = target + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(c, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, target);
  cache = clone(c);
}

export async function addDenylistEntry(entry: DenylistEntry): Promise<void> {
  const c = await loadConfig();
  // De-dupe: if an entry with the same id already exists, replace it.
  const without = c.clusterDenylist.filter((e) => e.id !== entry.id);
  c.clusterDenylist = [...without, entry];
  await saveConfig(c);
}

export async function removeDenylistEntry(id: string): Promise<boolean> {
  const c = await loadConfig();
  const before = c.clusterDenylist.length;
  c.clusterDenylist = c.clusterDenylist.filter((e) => e.id !== id);
  if (c.clusterDenylist.length === before) return false;
  await saveConfig(c);
  return true;
}

/** Test-only: reset the in-memory cache. Not part of the public API. */
export function _resetCache(): void {
  cache = null;
}
