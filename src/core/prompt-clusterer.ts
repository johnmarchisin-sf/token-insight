// Cheap prompt clustering: normalize + character-trigram Jaccard similarity,
// single-pass greedy assignment to cluster representatives.
//
// Goal: find recurring "shapes" of requests so we can recommend turning them
// into reusable skills/commands. Tuned for recall over precision — we'd rather
// surface a noisy cluster the user can eyeball than miss a real pattern.

import { Session, PromptCluster } from './types.js';

export interface ClusterOptions {
  /** Jaccard similarity above which a prompt joins an existing cluster. */
  similarity?: number;
  /** Minimum cluster size to keep in output. */
  minSize?: number;
  /** Cap on number of clusters returned, sorted by cost. */
  topN?: number;
  /** Drop prompts shorter than this many chars after normalization. */
  minPromptChars?: number;
  /** Drop prompts longer than this many chars (long pastes are not patterns). */
  maxPromptChars?: number;
}

const DEFAULTS: Required<ClusterOptions> = {
  similarity: 0.4,
  minSize: 2,
  topN: 25,
  minPromptChars: 12,
  maxPromptChars: 600,
};

interface PromptRecord {
  text: string;
  normalized: string;
  trigrams: Set<string>;
  workspace: string;
  cost: number;
  tokens: number;
}

interface ClusterAccum {
  rep: PromptRecord;
  members: PromptRecord[];
  totalCost: number;
  totalTokens: number;
  workspaces: Set<string>;
}

export function clusterPrompts(sessions: Session[], opts: ClusterOptions = {}): PromptCluster[] {
  const o = { ...DEFAULTS, ...opts };
  const records = collectPrompts(sessions, o);

  // Sort longest-first so cluster representatives tend to be the more specific
  // wording, and shorter variants get pulled into the cluster.
  records.sort((a, b) => b.normalized.length - a.normalized.length);

  const clusters: ClusterAccum[] = [];
  for (const r of records) {
    let best: ClusterAccum | null = null;
    let bestSim = 0;
    for (const c of clusters) {
      const sim = jaccard(r.trigrams, c.rep.trigrams);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= o.similarity) {
      best.members.push(r);
      best.totalCost += r.cost;
      best.totalTokens += r.tokens;
      best.workspaces.add(r.workspace);
    } else {
      clusters.push({
        rep: r,
        members: [r],
        totalCost: r.cost,
        totalTokens: r.tokens,
        workspaces: new Set([r.workspace]),
      });
    }
  }

  return clusters
    .filter((c) => c.members.length >= o.minSize)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, o.topN)
    .map<PromptCluster>((c) => ({
      representative: c.rep.text,
      size: c.members.length,
      totalTokens: c.totalTokens,
      totalCost: c.totalCost,
      workspaces: [...c.workspaces].sort(),
      examplePrompts: c.members.slice(0, 5).map((m) => m.text),
    }));
}

function collectPrompts(sessions: Session[], o: Required<ClusterOptions>): PromptRecord[] {
  const out: PromptRecord[] = [];
  for (const s of sessions) {
    // Build a turn-cost lookup: attribute the immediate next assistant turn's
    // cost back to the user prompt that triggered it.
    for (let i = 0; i < s.turns.length; i++) {
      const t = s.turns[i];
      if (t.role !== 'user') continue;
      if (!t.promptText) continue;
      const normalized = normalize(t.promptText);
      if (normalized.length < o.minPromptChars) continue;
      if (normalized.length > o.maxPromptChars) continue;

      // Find the cost of all assistant/tool turns up to the next user turn.
      let cost = 0;
      let tokens = 0;
      for (let j = i + 1; j < s.turns.length; j++) {
        const next = s.turns[j];
        if (next.role === 'user') break;
        cost += next.cost;
        tokens +=
          next.inputTokens +
          next.outputTokens +
          next.cacheWriteTokens +
          next.cacheReadTokens;
      }

      out.push({
        text: t.promptText.slice(0, 800),
        normalized,
        trigrams: trigramsOf(normalized),
        workspace: s.workspaceName,
        cost,
        tokens,
      });
    }
  }
  return out;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    // Strip fenced code blocks entirely — they're not part of the request shape.
    .replace(/```[\s\S]*?```/g, ' ')
    // Strip inline code.
    .replace(/`[^`]*`/g, ' ')
    // Strip URLs and file paths (often unique to the request, hurt clustering).
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w./-]*\/[\w./-]+/g, ' ')
    // Strip numbers (often unique IDs / line numbers).
    .replace(/\d+/g, ' ')
    // Collapse non-letters.
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigramsOf(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 3) {
    out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - 3; i++) {
    out.add(s.slice(i, i + 3));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
