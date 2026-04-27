// Heuristics that flag sessions likely to contain wasted spend.

import { Session, WasteFlag } from './types.js';

export interface WasteOptions {
  /** Multiplier above median total tokens to flag a session as an outlier. */
  outlierMultiplier?: number;
  /** Cache-read ratio above which a session is flagged as cache-bloated. */
  cacheBloatRatio?: number;
  /** Tokens-per-user-turn above which a session is flagged as inefficient. */
  bloatedTurnThreshold?: number;
  /** Minimum tokens before a session is even considered for flagging. */
  minTokens?: number;
}

const DEFAULTS: Required<WasteOptions> = {
  outlierMultiplier: 3,
  cacheBloatRatio: 0.7,
  bloatedTurnThreshold: 80_000,
  minTokens: 5_000,
};

export function detectWaste(sessions: Session[], opts: WasteOptions = {}): WasteFlag[] {
  const o = { ...DEFAULTS, ...opts };
  if (sessions.length === 0) return [];

  const tokens = sessions.map((s) => s.totals.totalTokens).sort((a, b) => a - b);
  const median = tokens[Math.floor(tokens.length / 2)] || 0;
  const outlierThreshold = Math.max(o.minTokens, median * o.outlierMultiplier);

  const flags: WasteFlag[] = [];
  for (const s of sessions) {
    if (s.totals.totalTokens < o.minTokens) continue;
    const reasons: string[] = [];
    const cacheRatio =
      s.totals.totalTokens > 0
        ? s.totals.cacheReadTokens / s.totals.totalTokens
        : 0;
    const tokensPerUserTurn =
      s.totals.userTurnCount > 0
        ? s.totals.totalTokens / s.totals.userTurnCount
        : s.totals.totalTokens;

    if (s.totals.totalTokens >= outlierThreshold) {
      reasons.push(`outlier (${(s.totals.totalTokens / median).toFixed(1)}x median session)`);
    }
    if (cacheRatio >= o.cacheBloatRatio && s.totals.cacheReadTokens > 50_000) {
      reasons.push(`cache-bloated (${(cacheRatio * 100).toFixed(0)}% reads)`);
    }
    if (tokensPerUserTurn >= o.bloatedTurnThreshold && s.totals.userTurnCount >= 2) {
      reasons.push(`bloated turns (${Math.round(tokensPerUserTurn).toLocaleString()} tok/turn)`);
    }
    // Long idle gaps (>30 min) inside a session — probably should have been split.
    let maxGapMs = 0;
    for (let i = 1; i < s.turns.length; i++) {
      const gap = s.turns[i].ts.getTime() - s.turns[i - 1].ts.getTime();
      if (gap > maxGapMs) maxGapMs = gap;
    }
    if (maxGapMs > 30 * 60_000) {
      reasons.push(`long idle gap (${Math.round(maxGapMs / 60_000)}m)`);
    }

    if (reasons.length === 0) continue;
    flags.push({
      sessionId: s.sessionId,
      workspaceName: s.workspaceName,
      filePath: s.filePath,
      startedAt: s.startedAt,
      totalTokens: s.totals.totalTokens,
      cost: s.totals.cost,
      reasons,
      cacheReadRatio: cacheRatio,
      tokensPerUserTurn,
    });
  }

  return flags.sort((a, b) => b.totalTokens - a.totalTokens);
}
