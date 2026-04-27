// Group all activity into rolling 5-hour usage windows ("blocks"), matching
// the way Claude's subscription rate limits are enforced. A new block opens
// on the first turn after the previous one expires (5h after its first turn).

import { Session } from './types.js';

export const BLOCK_DURATION_MS = 5 * 60 * 60_000;

export interface UsageBlock {
  startedAt: Date;
  endsAt: Date;          // startedAt + 5h, the rate-window boundary
  lastActivityAt: Date;
  isActive: boolean;     // endsAt > now (still within the live rate window)
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  turnCount: number;
  sessionIds: string[];
  workspaces: string[];
}

interface MutableBlock extends Omit<UsageBlock, 'sessionIds' | 'workspaces'> {
  _sessions: Set<string>;
  _workspaces: Set<string>;
}

function newBlock(startedAt: Date): MutableBlock {
  return {
    startedAt,
    endsAt: new Date(startedAt.getTime() + BLOCK_DURATION_MS),
    lastActivityAt: startedAt,
    isActive: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    turnCount: 0,
    _sessions: new Set(),
    _workspaces: new Set(),
  };
}

function freeze(b: MutableBlock): UsageBlock {
  return {
    startedAt: b.startedAt,
    endsAt: b.endsAt,
    lastActivityAt: b.lastActivityAt,
    isActive: b.isActive,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheWriteTokens: b.cacheWriteTokens,
    cacheReadTokens: b.cacheReadTokens,
    totalTokens: b.totalTokens,
    turnCount: b.turnCount,
    sessionIds: [...b._sessions],
    workspaces: [...b._workspaces].sort(),
  };
}

export function computeBlocks(sessions: Session[]): UsageBlock[] {
  // Flatten turns with their session/workspace tags, sort by ts.
  const items: Array<{
    ts: Date;
    sessionId: string;
    workspace: string;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  }> = [];
  for (const s of sessions) {
    for (const t of s.turns) {
      // Skip turns that have no token impact (system messages, summaries) so
      // they don't anchor empty blocks.
      const sum = t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens;
      if (sum === 0) continue;
      items.push({
        ts: t.ts,
        sessionId: s.sessionId,
        workspace: s.workspaceName,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        cacheReadTokens: t.cacheReadTokens,
      });
    }
  }
  items.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const blocks: MutableBlock[] = [];
  let cur: MutableBlock | null = null;
  for (const it of items) {
    if (!cur || it.ts.getTime() >= cur.endsAt.getTime()) {
      if (cur) blocks.push(cur);
      cur = newBlock(it.ts);
    }
    cur.lastActivityAt = it.ts;
    cur.inputTokens += it.inputTokens;
    cur.outputTokens += it.outputTokens;
    cur.cacheWriteTokens += it.cacheWriteTokens;
    cur.cacheReadTokens += it.cacheReadTokens;
    cur.totalTokens +=
      it.inputTokens + it.outputTokens + it.cacheWriteTokens + it.cacheReadTokens;
    cur.turnCount += 1;
    cur._sessions.add(it.sessionId);
    cur._workspaces.add(it.workspace);
  }
  if (cur) blocks.push(cur);

  const now = Date.now();
  for (const b of blocks) b.isActive = b.endsAt.getTime() > now;
  return blocks.map(freeze);
}

export function activeBlock(blocks: UsageBlock[]): UsageBlock | null {
  // The active block is the most recent block whose window hasn't ended.
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].isActive) return blocks[i];
  }
  return null;
}

/**
 * Peak total tokens observed in any single block within the lookback window.
 * We use this as a self-derived "ceiling" — when the active block approaches
 * this number, the user is heading for a rate-limit wall.
 */
export function peakInLookback(blocks: UsageBlock[], lookbackDays: number): number {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60_000;
  let peak = 0;
  for (const b of blocks) {
    if (b.startedAt.getTime() < cutoff) continue;
    if (b.totalTokens > peak) peak = b.totalTokens;
  }
  return peak;
}

export interface ActiveBlockProjection {
  elapsedMs: number;
  remainingMs: number;
  velocityTokensPerMin: number;
  projectedTotal: number;
  peakRecent: number;
  pctOfPeak: number;          // currentTotal / peakRecent
  pctOfPeakProjected: number; // projectedTotal / peakRecent
}

export function projectActive(
  active: UsageBlock | null,
  blocks: UsageBlock[],
  lookbackDays = 30
): ActiveBlockProjection | null {
  if (!active) return null;
  const now = Date.now();
  const elapsedMs = Math.max(1, now - active.startedAt.getTime());
  const remainingMs = Math.max(0, active.endsAt.getTime() - now);
  const velocityTokensPerMin = (active.totalTokens / elapsedMs) * 60_000;
  const projectedTotal = active.totalTokens + velocityTokensPerMin * (remainingMs / 60_000);
  const peakRecent = peakInLookback(
    blocks.filter((b) => !b.isActive), // exclude the active block itself
    lookbackDays
  );
  return {
    elapsedMs,
    remainingMs,
    velocityTokensPerMin,
    projectedTotal,
    peakRecent,
    pctOfPeak: peakRecent > 0 ? active.totalTokens / peakRecent : 0,
    pctOfPeakProjected: peakRecent > 0 ? projectedTotal / peakRecent : 0,
  };
}
