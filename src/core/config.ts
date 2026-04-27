// Persistent user config for token-insight: stored in ~/.token-insight.json,
// auto-created with defaults, atomically written to survive crashes/races.
//
// The cluster denylist is the only persisted state today; the file is shaped
// to grow (future: user-defined workspace aliases, threshold overrides).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface DenylistEntry {
  id: string;
  reason: 'denied' | 'created';
  repExcerpt: string;
  trigrams: string[];
  addedAt: string; // ISO timestamp
}

export interface TokenInsightConfig {
  clusterDenylist: DenylistEntry[];
}

const DEFAULT_CONFIG: TokenInsightConfig = {
  clusterDenylist: [],
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
  return { clusterDenylist: clean };
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
