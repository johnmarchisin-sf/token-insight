// Roll up signals from the analyzers into concrete actionable recommendations.
//
// Each recommendation has:
//   - kind:  what category (skill, hook, subagent, context, model, etc.)
//   - severity: rough priority (low/medium/high)
//   - title: one-line summary
//   - body:  longer explanation
//   - action: optional concrete CLI/command suggestion the user can run
//   - evidence: backing data so the user can sanity-check

import { Session, PromptCluster } from './types.js';
import { ContextReport, GlobalContextReport } from './context-inspector.js';
import { FileReadStat, rereadCandidates } from './file-reads.js';

export type RecKind = 'skill' | 'context' | 'hook' | 'subagent' | 'model' | 'session';
export type RecSeverity = 'high' | 'medium' | 'low';

export interface Recommendation {
  kind: RecKind;
  severity: RecSeverity;
  title: string;
  body: string;
  action?: string;
  evidence?: Record<string, unknown>;
}

export interface RecommendInputs {
  sessions: Session[];
  clusters: PromptCluster[];
  contextReports: ContextReport[];
  globalContext: GlobalContextReport;
  fileReads: FileReadStat[];
}

export function buildRecommendations(inputs: RecommendInputs): Recommendation[] {
  const recs: Recommendation[] = [];
  recs.push(...skillRecs(inputs.clusters));
  recs.push(...contextRecs(inputs.contextReports, inputs.globalContext));
  recs.push(...rereadRecs(inputs.fileReads));
  recs.push(...subagentRecs(inputs.sessions));
  recs.push(...modelRecs(inputs.sessions));
  return recs.sort(severityOrder);
}

// ----- Skill candidates from prompt clusters --------------------------------

function skillRecs(clusters: PromptCluster[]): Recommendation[] {
  const out: Recommendation[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if (c.size < 3) continue;
    if (c.totalTokens < 50_000) continue;
    out.push({
      kind: 'skill',
      severity: c.totalTokens > 500_000 ? 'high' : c.size >= 5 ? 'medium' : 'low',
      title: `Turn this into a skill — repeated ${c.size}× across ${c.workspaces.length} workspace(s)`,
      body:
        `You've made ${c.size} similar requests that consumed ${formatTokens(c.totalTokens)} tokens combined. ` +
        `Bundling the workflow into a slash command, hook, or skill replaces the boilerplate prompt with a tight invocation. ` +
        `Representative prompt: "${truncate(c.representative, 160)}"`,
      action: `ti draft-skill --cluster ${i + 1}`,
      evidence: {
        clusterIndex: i + 1,
        size: c.size,
        totalTokens: c.totalTokens,
        workspaces: c.workspaces,
      },
    });
  }
  return out;
}

// ----- CLAUDE.md / context bloat --------------------------------------------

function contextRecs(reports: ContextReport[], global: GlobalContextReport): Recommendation[] {
  const out: Recommendation[] = [];
  // Global CLAUDE.md bloat.
  if (global.exists && global.estimatedTokens > 4_000) {
    out.push({
      kind: 'context',
      severity: global.estimatedTokens > 10_000 ? 'high' : 'medium',
      title: `Global ~/.claude/CLAUDE.md is large (~${formatTokens(global.estimatedTokens)} tokens)`,
      body:
        `Your global CLAUDE.md is ${global.lines} lines and gets loaded into every Claude Code session — ` +
        `every workspace, every conversation. Trim it to the essentials and move workspace-specific context ` +
        `into per-workspace CLAUDE.md files.`,
      evidence: { filePath: global.filePath, lines: global.lines, bytes: global.bytes },
    });
  }

  for (const r of reports) {
    // Per-workspace CLAUDE.md bloat.
    const totalTokens = r.totalEstimatedTokens;
    if (totalTokens > 4_000) {
      out.push({
        kind: 'context',
        severity: totalTokens > 10_000 ? 'high' : 'medium',
        title: `${r.workspaceName}: CLAUDE.md is ~${formatTokens(totalTokens)} tokens`,
        body:
          `Workspace CLAUDE.md(s) total ${r.files.reduce((s, f) => s + f.lines, 0)} lines. ` +
          `Every line is paid for on every prompt in this workspace. Audit for stale context, move long ` +
          `examples to @-imported files, and prefer skills for procedural knowledge.`,
        evidence: { workspace: r.workspaceName, files: r.files.map((f) => f.filePath) },
      });
    }

    // Stale @-imports.
    if (r.missingImports.length > 0) {
      out.push({
        kind: 'context',
        severity: 'medium',
        title: `${r.workspaceName}: ${r.missingImports.length} stale reference(s) in CLAUDE.md`,
        body:
          `Your CLAUDE.md references files that no longer exist. Stale references waste tokens (the path ` +
          `text itself) and confuse Claude when it tries to follow them. Remove or fix:\n` +
          r.missingImports.slice(0, 5).map((m) => `  • ${m.reference}`).join('\n'),
        evidence: { workspace: r.workspaceName, missing: r.missingImports },
      });
    }

    // Bulky @-imports.
    if (r.bulkyImports.length > 0) {
      const totalImported = r.bulkyImports.reduce((s, b) => s + b.estimatedTokens, 0);
      out.push({
        kind: 'context',
        severity: totalImported > 20_000 ? 'high' : 'medium',
        title: `${r.workspaceName}: large @-imports loading ~${formatTokens(totalImported)} tokens`,
        body:
          `${r.bulkyImports.length} file(s) imported from CLAUDE.md exceed 4k tokens each. ` +
          `Consider whether the full file needs to be in context every time, or whether a summary or ` +
          `on-demand load via Read tool would work:\n` +
          r.bulkyImports
            .slice(0, 5)
            .map((b) => `  • ${b.reference} (~${formatTokens(b.estimatedTokens)} tok)`)
            .join('\n'),
        evidence: { workspace: r.workspaceName, bulky: r.bulkyImports },
      });
    }
  }
  return out;
}

// ----- Files re-read many times → CLAUDE.md @import or hook -----------------

function rereadRecs(fileReads: FileReadStat[]): Recommendation[] {
  const out: Recommendation[] = [];
  const candidates = rereadCandidates(fileReads, 3);
  for (const f of candidates.slice(0, 10)) {
    out.push({
      kind: 'hook',
      severity: f.readsPerSessionAvg > 8 ? 'high' : 'medium',
      title: `${shortName(f.filePath)} read ${f.readsPerSessionAvg.toFixed(1)}× per session on average`,
      body:
        `This file shows up in ${f.sessionCount} sessions across ${f.workspaces.length} workspace(s), with ` +
        `${f.totalReads} total Read tool calls. Re-reading the same file racks up cache_read tokens. ` +
        `Options: add it as an @-import in CLAUDE.md (so it's loaded once and cached), or add a SessionStart ` +
        `hook that pre-loads it.`,
      evidence: {
        filePath: f.filePath,
        totalReads: f.totalReads,
        sessions: f.sessionCount,
        avg: f.readsPerSessionAvg,
        workspaces: f.workspaces,
      },
    });
  }
  return out;
}

// ----- Subagent opportunities -----------------------------------------------

function subagentRecs(sessions: Session[]): Recommendation[] {
  // Sessions with lots of turns and very few/no sidechain turns are candidates
  // for offloading exploration to a subagent.
  const candidates = sessions.filter((s) => {
    if (s.totals.turnCount < 60) return false;
    const sidechain = s.turns.filter((t) => t.isSidechain).length;
    return sidechain < 5;
  });
  if (candidates.length === 0) return [];
  // Aggregate by workspace.
  const byWs = new Map<string, { sessions: number; tokens: number }>();
  for (const c of candidates) {
    const cur = byWs.get(c.workspaceName) || { sessions: 0, tokens: 0 };
    cur.sessions += 1;
    cur.tokens += c.totals.totalTokens;
    byWs.set(c.workspaceName, cur);
  }
  const out: Recommendation[] = [];
  for (const [ws, agg] of byWs) {
    if (agg.sessions < 2) continue;
    out.push({
      kind: 'subagent',
      severity: agg.tokens > 1_000_000 ? 'high' : 'medium',
      title: `${ws}: ${agg.sessions} long sessions without subagent use`,
      body:
        `Long sessions (>60 turns) consumed ${formatTokens(agg.tokens)} tokens here without using subagents. ` +
        `When you're doing exploration ("find all X", "where is Y handled", "summarize how Z works"), ` +
        `delegating to the Agent/Task tool keeps the main session's context lean. The subagent's transcript ` +
        `doesn't pollute your main conversation.`,
      evidence: { workspace: ws, sessionCount: agg.sessions, totalTokens: agg.tokens },
    });
  }
  return out;
}

// ----- Model usage ---------------------------------------------------------

function modelRecs(sessions: Session[]): Recommendation[] {
  const out: Recommendation[] = [];
  // Count tokens by model tier.
  let opus = 0;
  let sonnet = 0;
  let haiku = 0;
  let other = 0;
  for (const s of sessions) {
    for (const t of s.turns) {
      const n = t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens;
      const m = (t.model || '').toLowerCase();
      if (m.includes('opus')) opus += n;
      else if (m.includes('sonnet')) sonnet += n;
      else if (m.includes('haiku')) haiku += n;
      else other += n;
    }
  }
  const total = opus + sonnet + haiku + other;
  if (total === 0) return out;
  const opusPct = opus / total;
  if (opusPct > 0.4) {
    out.push({
      kind: 'model',
      severity: 'medium',
      title: `Opus accounts for ${Math.round(opusPct * 100)}% of your token usage`,
      body:
        `Opus is great for hard reasoning and architecture, but for a lot of routine work — file reads, ` +
        `simple edits, well-defined refactors — Sonnet handles it at a fraction of the rate-window cost. ` +
        `If you're hitting limits, shifting routine sessions to Sonnet is one of the highest-leverage moves.`,
      evidence: { opusTokens: opus, sonnetTokens: sonnet, haikuTokens: haiku },
    });
  }
  return out;
}

// ----- helpers --------------------------------------------------------------

const ORDER: Record<RecSeverity, number> = { high: 0, medium: 1, low: 2 };
function severityOrder(a: Recommendation, b: Recommendation): number {
  return ORDER[a.severity] - ORDER[b.severity];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function truncate(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length <= n ? oneline : oneline.slice(0, n - 1) + '…';
}

function shortName(fp: string): string {
  const parts = fp.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}
