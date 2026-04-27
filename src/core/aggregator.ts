// Aggregations across sessions: by workspace, by day, by model.

import { Session, SessionTotals } from './types.js';

export interface Bucket {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  sessionCount: number;
  turnCount: number;
}

function emptyBucket(key: string, label: string): Bucket {
  return {
    key,
    label,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cost: 0,
    sessionCount: 0,
    turnCount: 0,
  };
}

function addToBucket(b: Bucket, t: SessionTotals): void {
  b.inputTokens += t.inputTokens;
  b.outputTokens += t.outputTokens;
  b.cacheWriteTokens += t.cacheWriteTokens;
  b.cacheReadTokens += t.cacheReadTokens;
  b.totalTokens += t.totalTokens;
  b.cost += t.cost;
  b.sessionCount += 1;
  b.turnCount += t.turnCount;
}

function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function byWorkspace(sessions: Session[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const s of sessions) {
    const key = s.workspaceName;
    if (!map.has(key)) map.set(key, emptyBucket(key, s.workspaceName));
    addToBucket(map.get(key)!, s.totals);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function byWorkspaceGroup(sessions: Session[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const s of sessions) {
    const key = s.workspaceGroup;
    if (!map.has(key)) map.set(key, emptyBucket(key, s.workspaceGroup));
    addToBucket(map.get(key)!, s.totals);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function byDay(sessions: Session[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const s of sessions) {
    const key = localYmd(s.startedAt);
    if (!map.has(key)) map.set(key, emptyBucket(key, key));
    addToBucket(map.get(key)!, s.totals);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function byModel(sessions: Session[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const s of sessions) {
    // Walk turns to attribute per-model, since a session can mix models.
    for (const t of s.turns) {
      const key = t.model || 'unknown';
      if (!map.has(key)) map.set(key, emptyBucket(key, key));
      const b = map.get(key)!;
      b.inputTokens += t.inputTokens;
      b.outputTokens += t.outputTokens;
      b.cacheWriteTokens += t.cacheWriteTokens;
      b.cacheReadTokens += t.cacheReadTokens;
      b.totalTokens +=
        t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens;
      b.cost += t.cost;
      b.turnCount += 1;
    }
  }
  // sessionCount is meaningless across models — set to count of distinct sessions touching that model.
  const sessionsByModel = new Map<string, Set<string>>();
  for (const s of sessions) {
    for (const t of s.turns) {
      const key = t.model || 'unknown';
      if (!sessionsByModel.has(key)) sessionsByModel.set(key, new Set());
      sessionsByModel.get(key)!.add(s.sessionId);
    }
  }
  for (const [k, set] of sessionsByModel) {
    const b = map.get(k);
    if (b) b.sessionCount = set.size;
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function totalsAcross(sessions: Session[]): Bucket {
  const b = emptyBucket('all', 'All workspaces');
  for (const s of sessions) addToBucket(b, s.totals);
  return b;
}
