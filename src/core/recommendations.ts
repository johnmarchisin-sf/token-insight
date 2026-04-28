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
import { DenylistEntry } from './config.js';
import { findDenylistMatch } from './cluster-id.js';
import { SkillCatalogEntry } from './skill-catalog.js';
import { overlapCoefficient } from './cluster-id.js';
import { BashPattern, extractBashPatterns } from './bash-patterns.js';

export type RecKind = 'skill' | 'context' | 'hook' | 'subagent' | 'model' | 'session';
export type RecSeverity = 'high' | 'medium' | 'low';

export const SKILL_MATCH_OVERLAP = 0.5;
export const SUBAGENT_EXPLORE_MIN = 15;
export const BORDERLINE_MIN_RECENT_SIZE = 3;
export const BORDERLINE_MIN_RECENT_TOKENS = 10_000;
// Wide-net thresholds — easy to tune up once we see real recs.
export const BASH_HOOK_MIN_COUNT = 5;
export const BASH_HOOK_MIN_SESSIONS = 2;
export const BASH_HOOK_POST_EDIT_RATIO = 0.5;
export const BASH_HOOK_SESSION_START_MIN = 5;
export const BASH_HOOK_SESSION_START_RATIO = 0.5;

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
  denylist?: DenylistEntry[];
  includeHidden?: boolean;
  skillCatalog?: SkillCatalogEntry[];
}

export function buildRecommendations(inputs: RecommendInputs): Recommendation[] {
  const recs: Recommendation[] = [];
  recs.push(...skillRecs(inputs.clusters, inputs.denylist ?? [], inputs.includeHidden ?? false, inputs.skillCatalog ?? []));
  recs.push(...borderlineRecs(inputs.clusters, inputs.denylist ?? [], inputs.includeHidden ?? false));
  recs.push(...contextRecs(inputs.contextReports, inputs.globalContext));
  recs.push(...rereadRecs(inputs.fileReads));
  recs.push(...bashHookRecs(inputs.sessions));
  recs.push(...sessionSubagentRecs(inputs.sessions));
  recs.push(...subagentRecs(inputs.sessions));
  recs.push(...modelRecs(inputs.sessions));
  return recs.sort(severityOrder);
}

// ----- Skill candidates from prompt clusters --------------------------------

function skillRecs(
  clusters: PromptCluster[],
  denylist: DenylistEntry[],
  includeHidden: boolean,
  catalog: SkillCatalogEntry[],
): Recommendation[] {
  const out: Recommendation[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if (c.size < 3) continue;
    if (c.totalTokens < 50_000) continue;
    const match = findDenylistMatch({ id: c.id, trigrams: c.trigrams }, denylist);
    if (match && !includeHidden) continue;
    const titlePrefix = match ? `[hidden: ${match.reason}] ` : '';

    const matched = bestSkillMatch(c.trigrams, catalog);
    const baseEvidence = {
      clusterId: c.id,
      clusterIndex: i + 1,
      size: c.size,
      totalTokens: c.totalTokens,
      workspaces: c.workspaces,
      representative: c.representative,
      examplePrompts: c.examplePrompts,
      hidden: match ? match.reason : undefined,
    };

    const repShort = describeCluster(c.representative);

    if (matched) {
      out.push({
        kind: 'skill',
        severity: c.totalTokens > 500_000 ? 'high' : c.size >= 5 ? 'medium' : 'low',
        title: `${titlePrefix}Use skill — ${matched.entry.label}: "${repShort}"`,
        body:
          `You've made ${c.size} similar requests (${formatTokens(c.totalTokens)} tokens) that look like they should ` +
          `be triggering ${matched.entry.label} (${matched.entry.source}). The skill isn't picking these up. ` +
          `Two ways to fix it: tighten the description so it triggers on these phrases, or — if the skill is ` +
          `workspace-scoped — promote it to global.\n` +
          `Skill file: ${matched.entry.skillPath}`,
        action: `code ${matched.entry.skillPath}`,
        evidence: {
          ...baseEvidence,
          matchedSkill: {
            label: matched.entry.label,
            name: matched.entry.name,
            source: matched.entry.source,
            skillPath: matched.entry.skillPath,
            similarity: matched.similarity,
          },
        },
      });
      continue;
    }

    out.push({
      kind: 'skill',
      severity: c.totalTokens > 500_000 ? 'high' : c.size >= 5 ? 'medium' : 'low',
      title: `${titlePrefix}Turn into skill: "${repShort}"`,
      body:
        `You've made ${c.size} similar requests that consumed ${formatTokens(c.totalTokens)} tokens combined. ` +
        `Bundling the workflow into a slash command, hook, or skill replaces the boilerplate prompt with a tight invocation. ` +
        `Representative prompt: "${truncate(c.representative, 160)}"`,
      action: `ti draft-skill --cluster ${i + 1}`,
      evidence: baseEvidence,
    });
  }
  return out;
}

// Clusters that haven't yet crossed the full skill threshold (size >= 3,
// tokens >= 50k) but are picking up steam in the last 7 days. Surfaces them as
// low-severity recs so the user can flag them as future skills early.
function borderlineRecs(
  clusters: PromptCluster[],
  denylist: DenylistEntry[],
  includeHidden: boolean,
): Recommendation[] {
  const out: Recommendation[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    // Skip anything skillRecs already emitted.
    if (c.size >= 3 && c.totalTokens >= 50_000) continue;
    if (c.recentSize < BORDERLINE_MIN_RECENT_SIZE) continue;
    if (c.recentTokens < BORDERLINE_MIN_RECENT_TOKENS) continue;
    const match = findDenylistMatch({ id: c.id, trigrams: c.trigrams }, denylist);
    if (match && !includeHidden) continue;
    const titlePrefix = match ? `[hidden: ${match.reason}] ` : '';
    const repShort = describeCluster(c.representative);
    out.push({
      kind: 'skill',
      severity: 'low',
      title: `${titlePrefix}Trending — keep an eye on: "${repShort}"`,
      body:
        `Below the skill threshold today (${c.size} total, ${formatTokens(c.totalTokens)} tokens), but ${c.recentSize}× ` +
        `in the last 7 days (${formatTokens(c.recentTokens)} tokens). If this keeps repeating it's worth turning into ` +
        `a skill before it eats more context. Hide if it's a one-off coincidence.`,
      action: `ti draft-skill --cluster ${i + 1}`,
      evidence: {
        clusterId: c.id,
        clusterIndex: i + 1,
        size: c.size,
        totalTokens: c.totalTokens,
        recentSize: c.recentSize,
        recentTokens: c.recentTokens,
        workspaces: c.workspaces,
        representative: c.representative,
        examplePrompts: c.examplePrompts,
        borderline: true,
        hidden: match ? match.reason : undefined,
      },
    });
  }
  return out;
}

interface SkillMatch {
  entry: SkillCatalogEntry;
  similarity: number;
}

function bestSkillMatch(clusterTrigrams: string[], catalog: SkillCatalogEntry[]): SkillMatch | null {
  let best: SkillMatch | null = null;
  for (const entry of catalog) {
    if (entry.referenceTrigrams.length === 0) continue;
    const sim = overlapCoefficient(clusterTrigrams, entry.referenceTrigrams);
    if (sim < SKILL_MATCH_OVERLAP) continue;
    if (!best || sim > best.similarity) best = { entry, similarity: sim };
  }
  return best;
}

// Pulls a short, human-readable summary out of a cluster's representative
// prompt for use in rec titles. Strips obvious boilerplate ("can you", "please",
// "i want to") so the title leads with the verb/noun. Caps at ~70 chars.
function describeCluster(rep: string): string {
  const cleaned = rep
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(can you|could you|please|i want to|i'd like to|let's|hey)\s+/i, '')
    .replace(/^(can we|could we)\s+/i, '');
  return truncate(cleaned, 70);
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

// ----- Repeated bash commands → PostToolUse / SessionStart hook -------------

function bashHookRecs(sessions: Session[]): Recommendation[] {
  const patterns = extractBashPatterns(sessions);
  const out: Recommendation[] = [];

  for (const p of patterns) {
    if (p.count < BASH_HOOK_MIN_COUNT) continue;
    // Skip single-session patterns — that's just iteration on one task, not a
    // habit worth hooking.
    if (p.sessionCount < BASH_HOOK_MIN_SESSIONS) continue;
    const example = p.examples[0] || p.shape;

    const postEditRatio = p.postEditCount / p.count;
    if (postEditRatio >= BASH_HOOK_POST_EDIT_RATIO && p.postEditCount >= BASH_HOOK_MIN_COUNT) {
      out.push({
        kind: 'hook',
        severity: p.count > 25 ? 'high' : 'medium',
        title: `Hook candidate (PostToolUse): "${truncate(example, 60)}"`,
        body:
          `"${example}" runs ${p.count}× across ${p.sessionCount} session(s) in ${p.workspaceCount} workspace(s), ` +
          `${Math.round(postEditRatio * 100)}% of the time right after a file edit. Adding it as a PostToolUse hook ` +
          `on Edit|Write|MultiEdit means it runs automatically — no more typing it. Drop the snippet below into ` +
          `~/.claude/settings.json (global) or <workspace>/.claude/settings.json (project-local).`,
        action: '~/.claude/settings.json',
        evidence: {
          shape: p.shape,
          example,
          count: p.count,
          sessionCount: p.sessionCount,
          workspaceCount: p.workspaceCount,
          postEditCount: p.postEditCount,
          postEditRatio,
          hookSnippet: renderPostEditHook(example),
        },
      });
      continue;
    }

    const sessionStartRatio = p.sessionStartCount / p.sessionCount;
    if (
      p.sessionStartCount >= BASH_HOOK_SESSION_START_MIN &&
      sessionStartRatio >= BASH_HOOK_SESSION_START_RATIO
    ) {
      out.push({
        kind: 'hook',
        severity: 'medium',
        title: `Hook candidate (SessionStart): "${truncate(example, 60)}"`,
        body:
          `"${example}" runs at the start of ${p.sessionStartCount} session(s) (${Math.round(sessionStartRatio * 100)}% ` +
          `of sessions where it's used at all). Promoting this to a SessionStart hook means it runs once per session ` +
          `automatically — and the result is cached, not re-typed. Drop the snippet below into your settings.json.`,
        action: '~/.claude/settings.json',
        evidence: {
          shape: p.shape,
          example,
          count: p.count,
          sessionCount: p.sessionCount,
          workspaceCount: p.workspaceCount,
          sessionStartCount: p.sessionStartCount,
          sessionStartRatio,
          hookSnippet: renderSessionStartHook(example),
        },
      });
    }
  }

  return out;
}

function renderPostEditHook(command: string): string {
  return [
    '{',
    '  "hooks": {',
    '    "PostToolUse": [',
    '      {',
    '        "matcher": "Edit|Write|MultiEdit",',
    '        "hooks": [',
    `          { "type": "command", "command": ${JSON.stringify(command)} }`,
    '        ]',
    '      }',
    '    ]',
    '  }',
    '}',
  ].join('\n');
}

function renderSessionStartHook(command: string): string {
  return [
    '{',
    '  "hooks": {',
    '    "SessionStart": [',
    '      {',
    '        "hooks": [',
    `          { "type": "command", "command": ${JSON.stringify(command)} }`,
    '        ]',
    '      }',
    '    ]',
    '  }',
    '}',
  ].join('\n');
}

// Re-export so tests / future callers can use the shape directly.
export { extractBashPatterns };
export type { BashPattern };

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

function sessionSubagentRecs(sessions: Session[]): Recommendation[] {
  const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

  interface Candidate {
    session: Session;
    exploreCount: number;
    hadEdit: boolean;
  }
  const candidates: Candidate[] = [];

  for (const s of sessions) {
    let exploreCount = 0;
    let hadEdit = false;
    let usedSubagent = false;
    let stopCounting = false;

    for (const t of s.turns) {
      if (t.isSidechain) usedSubagent = true;
      if (!t.toolCalls) continue;
      for (const tc of t.toolCalls) {
        if (tc.name === 'Task') usedSubagent = true;
        if (stopCounting) continue;
        if (READ_TOOLS.has(tc.name)) {
          exploreCount += 1;
        } else if (EDIT_TOOLS.has(tc.name)) {
          hadEdit = true;
          stopCounting = true;
        }
      }
    }

    if (usedSubagent) continue;
    if (exploreCount < SUBAGENT_EXPLORE_MIN) continue;
    candidates.push({ session: s, exploreCount, hadEdit });
  }

  candidates.sort((a, b) => b.exploreCount - a.exploreCount);
  const top = candidates.slice(0, 10);

  return top.map((c) => ({
    kind: 'subagent' as RecKind,
    severity: c.exploreCount > 30 ? ('high' as RecSeverity) : ('medium' as RecSeverity),
    title: `Exploration without subagent — ${c.session.workspaceName}, ${c.session.startedAt.toLocaleString()}`,
    body:
      `This session made ${c.exploreCount} Read/Glob/Grep calls ` +
      `${c.hadEdit ? 'before its first Edit' : 'and never edited a file'} and didn't use the Task agent. ` +
      `Long upfront exploration consumes the main context window — Task subagents have isolated transcripts ` +
      `that don't pollute your main session.`,
    evidence: {
      sessionId: c.session.sessionId,
      workspace: c.session.workspaceName,
      exploreCount: c.exploreCount,
      hadEdit: c.hadEdit,
      sessionStartedAt: c.session.startedAt.toISOString(),
    },
  }));
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
