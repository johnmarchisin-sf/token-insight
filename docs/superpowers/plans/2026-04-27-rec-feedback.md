# Recommendation Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-cluster 👎/👍 feedback to skill recommendations: persistent denylist with drift-tolerant matching, inline SKILL.md scaffold panel in the dashboard, CLI mirror (`--show-hidden`, `ti undeny <id>`), and refactor of the SKILL.md scaffolder so the dashboard and CLI share one builder.

**Architecture:** Add stable cluster identity (`id` + `trigrams`) on `PromptCluster`. New persistence module reads/writes `~/.token-insight.json` atomically. Recommendations engine takes an optional denylist input and skips clusters that match by exact id or Jaccard ≥ 0.7 trigram similarity. Dashboard server gains POST/DELETE deny + GET scaffold routes. Dashboard UI inlines the cluster representative into skill rec cards and adds two action buttons; the 👍 button opens an inline `<details>` panel that lazily fetches the scaffold + polish prompt and offers a "Mark as created" finalizer. The existing `ti draft-skill` CLI keeps working because its scaffold builder gets extracted into a reusable module.

**Tech Stack:** TypeScript, Node 18+, Express, vanilla browser JS, Chart.js (CDN). No new dependencies; sha1 via `node:crypto`.

**Spec:** [`docs/superpowers/specs/2026-04-27-rec-feedback-design.md`](../specs/2026-04-27-rec-feedback-design.md)

**Note on testing:** This project has no unit test framework. Each task ends with `npm run typecheck` and, where helpful, an `npx tsx -e "..."` sanity probe. End-to-end verification (clicking through the dashboard) is manual and is described in the spec — the implementing agents should not attempt to start the dev server (it blocks the agent).

---

### Task 1: Stable cluster identity (`id` + `trigrams`)

Adds `id` and `trigrams` to `PromptCluster` and emits them from `clusterPrompts`. New helper module for the id + Jaccard logic. Foundation for every later task.

**Files:**
- Create: `src/core/cluster-id.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/prompt-clusterer.ts`

- [ ] **Step 1: Create `src/core/cluster-id.ts`**

```typescript
// Stable identity helpers for prompt clusters.
//
// `clusterIdFor` produces a 12-char sha1 prefix of the cluster representative's
// normalized text. Stable across runs as long as the representative text
// doesn't change. Used as the persistence key for the denylist.
//
// `jaccard` is the same set-similarity used by the clusterer; we re-export it
// here so the recommendations engine and CLI can match denylisted clusters
// even when the representative text drifts (a cluster's trigrams stay
// substantially similar even when a longer prompt joins and bumps the rep).

import { createHash } from 'node:crypto';

export function clusterIdFor(normalizedRep: string): string {
  return createHash('sha1').update(normalizedRep, 'utf8').digest('hex').slice(0, 12);
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  const [small, big] = A.size < B.size ? [A, B] : [B, A];
  for (const x of small) if (big.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface DenylistMatchInput {
  id: string;
  trigrams: string[];
}
export interface DenylistEntryShape {
  id: string;
  trigrams: string[];
}

/**
 * Returns the matching denylist entry if the cluster is denylisted (by exact
 * id match OR by Jaccard similarity >= threshold against any entry's trigrams).
 * Returns null otherwise.
 */
export function findDenylistMatch<T extends DenylistEntryShape>(
  cluster: DenylistMatchInput,
  denylist: T[],
  similarityThreshold = 0.7
): T | null {
  for (const entry of denylist) {
    if (entry.id === cluster.id) return entry;
  }
  for (const entry of denylist) {
    if (jaccard(cluster.trigrams, entry.trigrams) >= similarityThreshold) return entry;
  }
  return null;
}
```

- [ ] **Step 2: Modify `src/core/types.ts`**

Find the `PromptCluster` interface (currently lines 73–80) and add `id: string` as the first field and `trigrams: string[]` as the last:

```typescript
export interface PromptCluster {
  id: string;
  representative: string;
  size: number;
  totalTokens: number;
  totalCost: number;
  workspaces: string[];
  examplePrompts: string[];
  trigrams: string[];
}
```

- [ ] **Step 3: Emit `id` and `trigrams` from `clusterPrompts`**

In `src/core/prompt-clusterer.ts`, import `clusterIdFor`:

```typescript
import { clusterIdFor } from './cluster-id.js';
```

Then update the `.map<PromptCluster>(...)` block at the end of `clusterPrompts` (currently lines 87–94) to include the new fields:

```typescript
.map<PromptCluster>((c) => ({
  id: clusterIdFor(c.rep.normalized),
  representative: c.rep.text,
  size: c.members.length,
  totalTokens: c.totalTokens,
  totalCost: c.totalCost,
  workspaces: [...c.workspaces].sort(),
  examplePrompts: c.members.slice(0, 5).map((m) => m.text),
  trigrams: [...c.rep.trigrams],
}));
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Sanity probe**

```bash
npx tsx -e "
  import { clusterIdFor, jaccard, findDenylistMatch } from './src/core/cluster-id.ts';
  // 1. Determinism
  const a = clusterIdFor('hello world');
  const b = clusterIdFor('hello world');
  console.log('same input -> same id:', a === b, '(' + a + ')');
  console.log('id length:', a.length);
  // 2. Different input, different id
  const c = clusterIdFor('hello world!');
  console.log('different input -> different id:', a !== c);
  // 3. Jaccard
  console.log('jaccard identical:', jaccard(['a', 'b', 'c'], ['a', 'b', 'c']));
  console.log('jaccard half overlap:', jaccard(['a', 'b'], ['b', 'c']));
  console.log('jaccard disjoint:', jaccard(['a', 'b'], ['c', 'd']));
  // 4. Denylist match
  const dl = [{ id: 'xx', trigrams: ['hel', 'ell', 'llo'] }];
  const cluster = { id: 'xx', trigrams: ['unrelated'] };
  console.log('id-match:', findDenylistMatch(cluster, dl) !== null);
  const cluster2 = { id: 'yy', trigrams: ['hel', 'ell', 'llo', 'lo '] };
  console.log('trigram-match:', findDenylistMatch(cluster2, dl) !== null);
"
```

Expected output (key lines):
```
same input -> same id: true (...)
id length: 12
different input -> different id: true
jaccard identical: 1
jaccard half overlap: 0.3333333333333333
jaccard disjoint: 0
id-match: true
trigram-match: true
```

- [ ] **Step 6: Commit**

```bash
git add src/core/cluster-id.ts src/core/types.ts src/core/prompt-clusterer.ts
git commit -m "feat(clusters): stable cluster id + trigrams on PromptCluster"
```

---

### Task 2: Config persistence (`~/.token-insight.json`)

Adds the persistence module. No consumers yet — those wire up in later tasks. Atomic writes; defaults on missing/corrupt; in-memory cache invalidated on every write.

**Files:**
- Create: `src/core/config.ts`

- [ ] **Step 1: Create `src/core/config.ts`**

```typescript
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
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Sanity probe (round-trip with a tmp HOME)**

```bash
TMPDIR_TI=$(mktemp -d)
HOME="$TMPDIR_TI" npx tsx -e "
  import { loadConfig, addDenylistEntry, removeDenylistEntry, _resetCache } from './src/core/config.ts';
  (async () => {
    let c = await loadConfig();
    console.log('initial empty:', c.clusterDenylist.length === 0);
    await addDenylistEntry({
      id: 'abc',
      reason: 'denied',
      repExcerpt: 'hello',
      trigrams: ['hel', 'ell', 'llo'],
      addedAt: new Date().toISOString(),
    });
    _resetCache();
    c = await loadConfig();
    console.log('after add:', c.clusterDenylist.length === 1, c.clusterDenylist[0].id);
    const removed = await removeDenylistEntry('abc');
    console.log('remove returned:', removed);
    _resetCache();
    c = await loadConfig();
    console.log('after remove:', c.clusterDenylist.length === 0);
    // Idempotent remove
    const removedAgain = await removeDenylistEntry('abc');
    console.log('remove missing returned:', removedAgain);
  })();
"
rm -rf "$TMPDIR_TI"
```

Expected output:
```
initial empty: true
after add: true abc
remove returned: true
after remove: true
remove missing returned: false
```

- [ ] **Step 4: Commit**

```bash
git add src/core/config.ts
git commit -m "feat(config): add ~/.token-insight.json persistence with cluster denylist"
```

---

### Task 3: Extract SKILL.md scaffolder

Moves `buildSkillBody`, `buildPolishPrompt`, and `makeSlug` out of `src/commands/draft-skill.ts` into a reusable `src/core/skill-scaffold.ts`. Refactors `draft-skill.ts` to import them. No behavior change for the existing CLI command.

**Files:**
- Create: `src/core/skill-scaffold.ts`
- Modify: `src/commands/draft-skill.ts`

- [ ] **Step 1: Create `src/core/skill-scaffold.ts`**

```typescript
// Build a starter SKILL.md scaffold + polish prompt from a prompt cluster.
// Used by both the `ti draft-skill` CLI and the dashboard's inline drafter.

import { PromptCluster } from './types.js';

export interface SkillScaffold {
  slug: string;
  skillBody: string;
  polishPrompt: string;
}

const STOP = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'have', 'are',
  'you', 'your', 'can', 'will', 'should', 'would', 'could', 'all', 'any',
  'how', 'what', 'where', 'when', 'why', 'use', 'using', 'help', 'please',
]);

export function buildSkillScaffold(cluster: PromptCluster): SkillScaffold {
  const slug = makeSlug(cluster.representative);
  const skillBody = buildSkillBody(cluster, slug);
  const polishPrompt = buildPolishPrompt(cluster);
  return { slug, skillBody, polishPrompt };
}

export function makeSlug(rep: string): string {
  const s = rep
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 4)
    .join('-');
  return s || 'untitled-skill';
}

function humanize(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildSkillBody(cluster: PromptCluster, slug: string): string {
  const triggers = cluster.examplePrompts
    .slice(0, 8)
    .map((p) => `- "${truncate(p, 140)}"`)
    .join('\n');

  return `---
name: ${slug}
description: TODO — one sentence triggering description. Mention the verbs and nouns from the trigger phrases below so Claude knows when to use this.
---

# ${humanize(slug)}

> **Auto-drafted by token-insight** from a cluster of ${cluster.size} similar prompts (${formatTokens(cluster.totalTokens)} tokens combined). Edit before using.

## When to use this skill

Trigger phrases observed in your usage:

${triggers}

## What this skill should do

TODO — describe the procedure that should run when triggered. Currently you're typing variations of the prompts above; codify the canonical workflow here so Claude doesn't have to re-derive it each time.

## Reference inputs

TODO — list any files, paths, or environment details Claude needs to know about. Strong candidates: configs, schemas, or rules that you currently re-explain in each prompt.

## Output expectations

TODO — what should the deliverable look like? File written? Summary printed? Issue created?

## Notes

- Workspaces this pattern came from: ${cluster.workspaces.join(', ')}
- Representative example prompt:
  > ${truncate(cluster.representative, 300)}
`;
}

function buildPolishPrompt(cluster: PromptCluster): string {
  const examples = cluster.examplePrompts.slice(0, 8).map((p, i) => `${i + 1}. ${p}`).join('\n\n');
  return `# Polish this skill draft

token-insight noticed I keep making this kind of request (${cluster.size}× so far, ${formatTokens(cluster.totalTokens)} tokens spent). I want to turn it into a reusable skill so I stop typing variants of the same prompt.

## What I keep asking

${examples}

## What I want

Read the SKILL.md scaffold I just generated alongside this file. Then:

1. Replace the TODO sections with concrete content that codifies what you've been doing for me when I make these requests.
2. Tighten the description so it triggers reliably on the trigger phrases above but not on unrelated requests.
3. If a procedure has clear deterministic steps, write them as numbered steps. If parts are judgment calls, leave them as prose.
4. Flag any place where you'd benefit from me providing more context (rules, examples, file paths I usually mean).

Ask me clarifying questions before you finalize anything important.
`;
}

function truncate(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length <= n ? oneline : oneline.slice(0, n - 1) + '…';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
```

- [ ] **Step 2: Refactor `src/commands/draft-skill.ts` to import from the new module**

Replace the entire file contents with:

```typescript
// CLI: take a prompt cluster and emit a starter SKILL.md you can iterate on.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadAllSessions } from '../core/jsonl-loader.js';
import { clusterPrompts } from '../core/prompt-clusterer.js';
import { buildSkillScaffold } from '../core/skill-scaffold.js';
import { bold, dim } from './format.js';

export interface DraftSkillOpts {
  cluster?: number;
  out?: string;
  days?: number;
}

export async function runDraftSkill(opts: DraftSkillOpts): Promise<void> {
  const since = opts.days ? new Date(Date.now() - opts.days * 24 * 60 * 60_000) : undefined;
  const sessions = await loadAllSessions(since ? { since } : {});
  const clusters = clusterPrompts(sessions, { topN: 25 });

  if (clusters.length === 0) {
    console.error('No clusters found. Try `ti analyze` first to confirm there are recurring patterns.');
    process.exit(1);
  }

  if (!opts.cluster) {
    console.log(bold('Pick a cluster to draft a skill for:'));
    console.log();
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      console.log(`  ${i + 1}. ${c.size}× repetitions, ${formatTokens(c.totalTokens)} tokens`);
      console.log(`     ${truncate(c.representative, 100)}`);
    }
    console.log();
    console.log(dim('Run `ti draft-skill --cluster <n>` to scaffold one.'));
    return;
  }

  const idx = opts.cluster - 1;
  if (idx < 0 || idx >= clusters.length) {
    console.error(`Cluster ${opts.cluster} out of range (1..${clusters.length}).`);
    process.exit(1);
  }
  const cluster = clusters[idx];
  const { slug, skillBody, polishPrompt } = buildSkillScaffold(cluster);

  const outPath = opts.out ?? path.resolve(process.cwd(), `${slug}-SKILL.md`);
  await fs.writeFile(outPath, skillBody, 'utf8');
  const promptPath = outPath.replace(/SKILL\.md$/, 'polish-prompt.md');
  await fs.writeFile(promptPath, polishPrompt, 'utf8');

  console.log(bold(`Drafted skill scaffold: ${outPath}`));
  console.log(dim(`Polish prompt:           ${promptPath}`));
  console.log();
  console.log('Next: open the polish prompt in Claude Code and let Claude finish the skill body using your real workflow.');
}

function truncate(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length <= n ? oneline : oneline.slice(0, n - 1) + '…';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
```

The two helpers (`truncate`, `formatTokens`) stay in this file because they're used in the CLI listing UX, not the scaffold itself. Everything related to building the SKILL.md / polish-prompt now lives in `skill-scaffold.ts`.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Sanity probe**

```bash
npx tsx -e "
  import { buildSkillScaffold } from './src/core/skill-scaffold.ts';
  const s = buildSkillScaffold({
    id: 'abc',
    representative: 'add a database migration for users.email',
    size: 5,
    totalTokens: 120000,
    totalCost: 0,
    workspaces: ['ws-a', 'ws-b'],
    examplePrompts: ['add migration for users.email', 'create migration adding email column'],
    trigrams: ['add', 'mig'],
  });
  console.log('slug:', s.slug);
  console.log('skillBody starts with frontmatter:', s.skillBody.startsWith('---'));
  console.log('polishPrompt starts with header:', s.polishPrompt.startsWith('# Polish'));
  console.log('skillBody mentions workspaces:', s.skillBody.includes('ws-a, ws-b'));
"
```

Expected:
```
slug: add-database-migration-users
skillBody starts with frontmatter: true
polishPrompt starts with header: true
skillBody mentions workspaces: true
```

(The exact slug may differ if the STOP list filters tokens differently — accept any slug 1+ chars that contains words from the input.)

- [ ] **Step 5: Commit**

```bash
git add src/core/skill-scaffold.ts src/commands/draft-skill.ts
git commit -m "refactor(draft-skill): extract scaffold builder into reusable module"
```

---

### Task 4: Wire denylist into recommendations engine

Recommendations engine accepts an optional `denylist` and skips clusters that match. Skill rec evidence carries `clusterId` for downstream consumers.

**Files:**
- Modify: `src/core/recommendations.ts`

- [ ] **Step 1: Update imports and `RecommendInputs`**

In `src/core/recommendations.ts`, add these imports near the top (after the existing imports from `./file-reads.js`):

```typescript
import { DenylistEntry } from './config.js';
import { findDenylistMatch } from './cluster-id.js';
```

Update `RecommendInputs` (currently lines 27–33) to:

```typescript
export interface RecommendInputs {
  sessions: Session[];
  clusters: PromptCluster[];
  contextReports: ContextReport[];
  globalContext: GlobalContextReport;
  fileReads: FileReadStat[];
  denylist?: DenylistEntry[];
  includeHidden?: boolean;
}
```

- [ ] **Step 2: Pass the denylist into `skillRecs`**

In `buildRecommendations` (currently line 35), update the first push line:

```typescript
recs.push(...skillRecs(inputs.clusters, inputs.denylist ?? [], inputs.includeHidden ?? false));
```

- [ ] **Step 3: Update `skillRecs` to filter and tag**

Replace `skillRecs` (currently lines 47–71) with:

```typescript
function skillRecs(
  clusters: PromptCluster[],
  denylist: DenylistEntry[],
  includeHidden: boolean,
): Recommendation[] {
  const out: Recommendation[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if (c.size < 3) continue;
    if (c.totalTokens < 50_000) continue;
    const match = findDenylistMatch({ id: c.id, trigrams: c.trigrams }, denylist);
    if (match && !includeHidden) continue;
    const titlePrefix = match ? `[hidden: ${match.reason}] ` : '';
    out.push({
      kind: 'skill',
      severity: c.totalTokens > 500_000 ? 'high' : c.size >= 5 ? 'medium' : 'low',
      title: `${titlePrefix}Turn this into a skill — repeated ${c.size}× across ${c.workspaces.length} workspace(s)`,
      body:
        `You've made ${c.size} similar requests that consumed ${formatTokens(c.totalTokens)} tokens combined. ` +
        `Bundling the workflow into a slash command, hook, or skill replaces the boilerplate prompt with a tight invocation. ` +
        `Representative prompt: "${truncate(c.representative, 160)}"`,
      action: `ti draft-skill --cluster ${i + 1}`,
      evidence: {
        clusterId: c.id,
        clusterIndex: i + 1,
        size: c.size,
        totalTokens: c.totalTokens,
        workspaces: c.workspaces,
        representative: c.representative,
        examplePrompts: c.examplePrompts,
        hidden: match ? match.reason : undefined,
      },
    });
  }
  return out;
}
```

Key changes:
- Imports `findDenylistMatch` and applies it to skip (or tag, if `includeHidden`) denylisted clusters.
- Adds `clusterId`, `representative`, `examplePrompts`, and `hidden` to `evidence` so the dashboard renders the inline rep without an extra fetch.

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendations.ts
git commit -m "feat(recommendations): filter denylisted clusters; expose clusterId in evidence"
```

---

### Task 5: CLI mirror — `recommend --show-hidden` and `ti undeny <id>`

**Files:**
- Modify: `src/commands/recommend.ts`
- Create: `src/commands/undeny.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Update `src/commands/recommend.ts`**

Replace the file contents with:

```typescript
import { loadAllSessions } from '../core/jsonl-loader.js';
import { clusterPrompts } from '../core/prompt-clusterer.js';
import { inspectAllWorkspaces, inspectGlobal } from '../core/context-inspector.js';
import { aggregateFileReads } from '../core/file-reads.js';
import { buildRecommendations, Recommendation } from '../core/recommendations.js';
import { loadConfig } from '../core/config.js';
import { bold, dim, warn, danger } from './format.js';

export interface RecommendOpts {
  json?: boolean;
  days?: number;
  kind?: string;
  showHidden?: boolean;
}

export async function runRecommend(opts: RecommendOpts): Promise<void> {
  const since = opts.days ? new Date(Date.now() - opts.days * 24 * 60 * 60_000) : undefined;
  const sessions = await loadAllSessions(since ? { since } : {});
  const [contextReports, globalContext, fileReads, config] = await Promise.all([
    inspectAllWorkspaces(sessions),
    inspectGlobal(),
    aggregateFileReads(sessions),
    loadConfig(),
  ]);
  const clusters = clusterPrompts(sessions, { topN: 25 });

  let recs = buildRecommendations({
    sessions,
    clusters,
    contextReports,
    globalContext,
    fileReads,
    denylist: config.clusterDenylist,
    includeHidden: opts.showHidden ?? false,
  });
  if (opts.kind) recs = recs.filter((r) => r.kind === opts.kind);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ count: recs.length, recommendations: recs }, null, 2) + '\n');
    return;
  }

  console.log(
    bold('Optimization recommendations') +
      (opts.days ? dim(` — last ${opts.days} days`) : dim(' — all time')) +
      (opts.showHidden ? dim(' · including hidden') : '')
  );
  console.log();
  if (recs.length === 0) {
    console.log(dim('No recommendations right now. Either you have very little usage history, or you have your house in order.'));
    return;
  }
  for (const r of recs) {
    console.log(`${severityBadge(r)} ${bold(r.title)}  ${dim(`[${r.kind}]`)}`);
    for (const line of r.body.split('\n')) console.log('   ' + line);
    if (r.action) console.log('   ' + dim('action: ') + r.action);
    if (r.kind === 'skill' && r.evidence?.clusterId) {
      console.log('   ' + dim('id:     ') + String(r.evidence.clusterId));
    }
    console.log();
  }
}

function severityBadge(r: Recommendation): string {
  if (r.severity === 'high') return danger('●');
  if (r.severity === 'medium') return warn('●');
  return dim('●');
}
```

Changes:
- Loads config alongside the other parallel fetches.
- Passes `denylist` and `includeHidden` to the recommendations builder.
- Prints the cluster id under each skill rec so the user can `ti undeny <id>`.
- Title prefix `[hidden: …]` is already supplied by the recommendations engine when `--show-hidden` is set.

- [ ] **Step 2: Create `src/commands/undeny.ts`**

```typescript
import { loadConfig, removeDenylistEntry } from '../core/config.js';
import { bold, dim } from './format.js';

export async function runUndeny(idOrPrefix: string): Promise<void> {
  const cfg = await loadConfig();
  const matches = cfg.clusterDenylist.filter(
    (e) => e.id === idOrPrefix || e.id.startsWith(idOrPrefix)
  );
  if (matches.length === 0) {
    console.error(`No denylist entry matches "${idOrPrefix}".`);
    console.error(dim('Run `ti recommend --show-hidden` to see ids.'));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Ambiguous prefix "${idOrPrefix}" — matches ${matches.length} entries:`);
    for (const m of matches) {
      console.error(`  ${m.id}  [${m.reason}]  ${m.repExcerpt.slice(0, 80)}`);
    }
    process.exit(1);
  }
  const target = matches[0];
  const removed = await removeDenylistEntry(target.id);
  if (removed) {
    console.log(bold(`Removed: ${target.id}  [${target.reason}]`));
    console.log(dim(`         ${target.repExcerpt.slice(0, 100)}`));
  } else {
    console.error('Entry no longer present (race?). Nothing to do.');
  }
}
```

- [ ] **Step 3: Wire flags + new command in `src/cli.ts`**

In `src/cli.ts`, add a new import near the other command imports:

```typescript
import { runUndeny } from './commands/undeny.js';
```

Update the `recommend` command registration to add the `--show-hidden` flag (currently lines 59–68):

```typescript
program
  .command('recommend')
  .alias('rec')
  .description('Concrete optimization recommendations across all signals')
  .option('--json', 'Output JSON instead of formatted text')
  .option('--days <n>', 'Limit signals to last N days', (v) => parseInt(v, 10))
  .option('--kind <k>', 'Filter by kind (skill, context, hook, subagent, model, session)')
  .option('--show-hidden', 'Include clusters previously hidden via 👎 / "Mark as created"')
  .action(async (opts) => {
    await runRecommend(opts);
  });
```

Add the new `undeny` command after the `draft-skill` command registration (currently around line 88):

```typescript
program
  .command('undeny <id>')
  .description('Remove a cluster from the denylist (run `ti recommend --show-hidden` to find ids; prefix matches accepted)')
  .action(async (id) => {
    await runUndeny(id);
  });
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Sanity probe — run `ti --help` to confirm the command is registered**

```bash
npx tsx src/cli.ts --help 2>&1 | head -40
```

Look for `undeny` in the listed commands and `--show-hidden` in the recommend section. (You may need to dig with `npx tsx src/cli.ts recommend --help`.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/recommend.ts src/commands/undeny.ts src/cli.ts
git commit -m "feat(cli): denylist-aware recommend + undeny command"
```

---

### Task 6: Dashboard server — POST/DELETE deny + GET scaffold + denylist in report

**Files:**
- Modify: `src/dashboard/server.ts`

- [ ] **Step 1: Update imports**

At the top of `src/dashboard/server.ts`, add the new imports after the existing ones from `recommendations.js`:

```typescript
import {
  loadConfig,
  addDenylistEntry,
  removeDenylistEntry,
} from '../core/config.js';
import { buildSkillScaffold } from '../core/skill-scaffold.js';
```

- [ ] **Step 2: Add JSON body parser middleware**

Find the line `app.use(express.static(publicDir));` (currently at line 50) and add the body-parser middleware immediately above it:

```typescript
app.use(express.json());
app.use(express.static(publicDir));
```

- [ ] **Step 3: Pipe the denylist through `getReport`**

Find `getReport` (currently lines 58–107). Replace the body so it loads the config and threads the denylist into `buildRecommendations`. Replace the existing `getReport` definition (and its enclosing `let cache: ...; const TTL_MS = 10_000;` block context) with:

```typescript
  let cache: { ts: number; data: any } | null = null;
  const TTL_MS = 10_000;

  function invalidateCache(): void {
    cache = null;
  }

  async function getReport() {
    if (cache && Date.now() - cache.ts < TTL_MS) return cache.data;
    const sessions = await loadAllSessions();
    const blocks = computeBlocks(sessions);
    const active = activeBlock(blocks);
    const projection = projectActive(active, blocks, 30);
    const peakRecent = peakInLookback(blocks, 30);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const today = sessions.filter((s) => s.endedAt >= startOfToday);

    const clusters = clusterPrompts(sessions, { topN: 25 });
    const [contextReports, globalContext, fileReads, config] = await Promise.all([
      inspectAllWorkspaces(sessions),
      inspectGlobal(),
      aggregateFileReads(sessions),
      loadConfig(),
    ]);
    const recommendations = buildRecommendations({
      sessions,
      clusters,
      contextReports,
      globalContext,
      fileReads,
      denylist: config.clusterDenylist,
    });

    const data = {
      generatedAt: new Date().toISOString(),
      totals: totalsAcross(sessions),
      todayTotals: totalsAcross(today),
      byDay: byDay(sessions),
      byWorkspace: byWorkspace(sessions),
      byGroup: byWorkspaceGroup(sessions),
      byModel: byModel(sessions),
      waste: detectWaste(sessions),
      clusters,
      sessionCount: sessions.length,
      activeBlock: active,
      activeProjection: projection,
      peakRecent,
      recentBlocks: blocks.slice(-14).reverse(),
      hourOfDay: byHourOfDay(sessions),
      dayHour: byDayHour(sessions),
      recommendations,
      contextReports,
      globalContext,
      fileReads,
      denylist: config.clusterDenylist,
    };
    cache = { ts: Date.now(), data };
    return data;
  }
```

Key changes vs current:
- Loads `config` in the parallel `Promise.all`.
- Passes `denylist: config.clusterDenylist` into `buildRecommendations`.
- Includes `denylist` in the response payload so the UI can render the "Hidden (N)" toggle without a separate fetch.
- Adds `invalidateCache()` helper used by the new write routes.

- [ ] **Step 4: Add the deny / undeny / scaffold routes**

Immediately after the existing `app.get('/api/health', ...)` registration (currently lines 118–120), add:

```typescript
  app.post('/api/cluster/:id/deny', async (req, res) => {
    const { id } = req.params;
    const reason = req.body && (req.body as any).reason;
    if (reason !== 'denied' && reason !== 'created') {
      res.status(400).json({ error: 'reason must be "denied" or "created"' });
      return;
    }
    try {
      const data = await getReport();
      const cluster = (data.clusters as any[]).find((c) => c.id === id);
      if (!cluster) {
        res.status(404).json({ error: `cluster ${id} not found` });
        return;
      }
      await addDenylistEntry({
        id: cluster.id,
        reason,
        repExcerpt: String(cluster.representative).slice(0, 200),
        trigrams: cluster.trigrams,
        addedAt: new Date().toISOString(),
      });
      invalidateCache();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/cluster/:id/deny', async (req, res) => {
    try {
      const removed = await removeDenylistEntry(req.params.id);
      invalidateCache();
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/cluster/:id/scaffold', async (req, res) => {
    try {
      const data = await getReport();
      const cluster = (data.clusters as any[]).find((c) => c.id === req.params.id);
      if (!cluster) {
        res.status(404).json({ error: `cluster ${req.params.id} not found` });
        return;
      }
      const scaffold = buildSkillScaffold(cluster);
      res.json(scaffold);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat(server): cluster deny/undeny/scaffold routes + denylist in report"
```

---

### Task 7: Dashboard UI — inline rep, feedback buttons, scaffold panel, hidden toggle

**Files:**
- Modify: `src/dashboard/public/app.js`
- Modify: `src/dashboard/public/styles.css`

(`index.html` does not need changes — the recommendations container `#recs-list` and the cluster panel `#clusters` are already in place.)

- [ ] **Step 1: Replace `renderRecommendations` in `app.js`**

In `src/dashboard/public/app.js`, locate `renderRecommendations(recs)` (currently lines 69–92). Replace with:

```javascript
function renderRecommendations(recs) {
  const container = $('recs-list');
  if (!recs.length) {
    container.innerHTML = '<p style="color:var(--text-dim);margin:0">No recommendations right now — your usage looks tidy.</p>';
    return;
  }
  container.innerHTML = recs
    .slice(0, 12)
    .map((r) => recCardHtml(r))
    .join('');
  if (recs.length > 12) {
    container.innerHTML += `<p style="color:var(--text-dim);font-size:12px;margin-top:8px">${recs.length - 12} more — run <code>ti recommend</code> for the full list.</p>`;
  }
  wireRecCardEvents();
}

function recCardHtml(r) {
  const cid = r.evidence && r.evidence.clusterId ? String(r.evidence.clusterId) : '';
  const isSkill = r.kind === 'skill' && cid;
  const rep = isSkill ? truncate(r.evidence.representative || '', 320) : '';
  const ws = isSkill && Array.isArray(r.evidence.workspaces) ? r.evidence.workspaces.join(', ') : '';
  const inlineRep = isSkill
    ? `<div class="rec-cluster-rep">"${escapeHtml(rep)}"</div>
       ${ws ? `<div class="rec-workspaces">workspaces: ${escapeHtml(ws)}</div>` : ''}`
    : '';
  const actions = isSkill
    ? `<div class="rec-actions">
         <button class="btn-hide" data-cid="${escapeHtml(cid)}" title="Hide — one-off, don't suggest again">👎 Hide</button>
         <button class="btn-draft" data-cid="${escapeHtml(cid)}" title="Open the SKILL.md scaffold">👍 Draft skill</button>
       </div>
       <details class="scaffold-panel" data-cid="${escapeHtml(cid)}" data-loaded="0">
         <summary class="scaffold-summary">Skill scaffold</summary>
         <div class="scaffold-body"><p class="scaffold-loading">Loading scaffold…</p></div>
       </details>`
    : '';
  return `
    <div class="rec ${r.severity}" data-cid="${escapeHtml(cid)}">
      <div class="severity">${r.severity}</div>
      <div class="body">
        <div class="title">${escapeHtml(r.title)}<span class="kind">${escapeHtml(r.kind)}</span></div>
        <div class="desc">${escapeHtml(r.body)}</div>
        ${inlineRep}
        ${r.action && !isSkill ? `<div class="action">${escapeHtml(r.action)}</div>` : ''}
        ${actions}
      </div>
    </div>`;
}

function wireRecCardEvents() {
  for (const btn of document.querySelectorAll('.btn-hide')) {
    btn.addEventListener('click', () => denyCluster(btn.dataset.cid, 'denied'));
  }
  for (const btn of document.querySelectorAll('.btn-draft')) {
    btn.addEventListener('click', (e) => {
      const cid = btn.dataset.cid;
      const panel = document.querySelector(`details.scaffold-panel[data-cid="${cid}"]`);
      if (!panel) return;
      panel.open = true;
      if (panel.dataset.loaded === '0') {
        panel.dataset.loaded = '1';
        loadScaffold(cid, panel);
      }
    });
  }
}

async function denyCluster(cid, reason) {
  if (!cid) return;
  const card = document.querySelector(`.rec[data-cid="${cid}"]`);
  if (card) card.style.opacity = '0.4';
  try {
    const res = await fetch(`/api/cluster/${encodeURIComponent(cid)}/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (card) card.remove();
    load();
  } catch (err) {
    if (card) card.style.opacity = '1';
    alert('Failed to hide: ' + err.message);
  }
}

async function unhideCluster(cid) {
  try {
    const res = await fetch(`/api/cluster/${encodeURIComponent(cid)}/deny`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    load();
  } catch (err) {
    alert('Failed to unhide: ' + err.message);
  }
}

async function loadScaffold(cid, panel) {
  const body = panel.querySelector('.scaffold-body');
  try {
    const res = await fetch(`/api/cluster/${encodeURIComponent(cid)}/scaffold`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    body.innerHTML = `
      <div class="scaffold-block">
        <div class="scaffold-block-head">
          <span>SKILL.md (${escapeHtml(s.slug)}-SKILL.md)</span>
          <button class="copy-btn" data-target="skill-${escapeHtml(cid)}">📋 Copy</button>
        </div>
        <pre id="skill-${escapeHtml(cid)}">${escapeHtml(s.skillBody)}</pre>
      </div>
      <div class="scaffold-block">
        <div class="scaffold-block-head">
          <span>Polish prompt</span>
          <button class="copy-btn" data-target="polish-${escapeHtml(cid)}">📋 Copy</button>
        </div>
        <pre id="polish-${escapeHtml(cid)}">${escapeHtml(s.polishPrompt)}</pre>
      </div>
      <button class="mark-created-btn" data-cid="${escapeHtml(cid)}">✓ Mark as created — hide from future runs</button>`;
    for (const cb of body.querySelectorAll('.copy-btn')) {
      cb.addEventListener('click', () => copyToClipboard(cb));
    }
    const mark = body.querySelector('.mark-created-btn');
    if (mark) mark.addEventListener('click', () => denyCluster(cid, 'created'));
  } catch (err) {
    body.innerHTML = `<p style="color:var(--danger)">Failed to load scaffold: ${escapeHtml(err.message)}</p>`;
  }
}

async function copyToClipboard(btn) {
  const target = document.getElementById(btn.dataset.target);
  if (!target) return;
  try {
    await navigator.clipboard.writeText(target.textContent || '');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1200);
  } catch (err) {
    alert('Copy failed: ' + err.message);
  }
}
```

The implementer should NOT delete any other functions — `load`, `render`, `escapeHtml`, `truncate` etc. all stay. The replacement targets `renderRecommendations` and adds the helper functions immediately after it.

- [ ] **Step 2: Add the hidden-clusters toggle to `renderClusters`**

Locate `renderClusters(clusters)` in `app.js` (currently around lines 421–447). The function body needs a small extension to render the denylist (passed via `d.denylist`) above the existing clusters list. Modify `render(d)` and `renderClusters` so the denylist arrives at the renderer.

In `render(d)` (around line 64), change the `renderClusters(d.clusters)` call to:

```javascript
renderClusters(d.clusters, d.denylist || []);
```

Then replace the `renderClusters` function with:

```javascript
function renderClusters(clusters, denylist) {
  const container = $('clusters');
  const hiddenHtml = denylist.length
    ? `<details class="hidden-clusters">
         <summary>Hidden (${denylist.length}) — show</summary>
         <div class="hidden-list">
           ${denylist.map((e) => `
             <div class="hidden-entry" data-cid="${escapeHtml(e.id)}">
               <div class="meta">
                 <span class="tag">${escapeHtml(e.reason)}</span>
                 <span class="hidden-id">${escapeHtml(e.id)}</span>
                 <span class="hidden-date">${escapeHtml(new Date(e.addedAt).toLocaleString())}</span>
               </div>
               <div class="hidden-rep">${escapeHtml(truncate(e.repExcerpt, 240))}</div>
               <button class="btn-unhide" data-cid="${escapeHtml(e.id)}">↺ Unhide</button>
             </div>`).join('')}
         </div>
       </details>`
    : '';
  if (!clusters || clusters.length === 0) {
    container.innerHTML = hiddenHtml + '<p style="color:var(--text-dim)">No recurring patterns surfaced yet — give it more usage history.</p>';
    wireUnhideEvents(container);
    return;
  }
  container.innerHTML = hiddenHtml + clusters
    .map(
      (c, i) => `
    <div class="cluster">
      <div class="meta">
        <span><strong>#${i + 1}</strong></span>
        <span><strong>${c.size}</strong> repetitions</span>
        <span><strong>${fmtTokens(c.totalTokens)}</strong> tokens</span>
        <span>workspaces: ${c.workspaces.map((w) => `<span class="tag">${escapeHtml(w)}</span>`).join('')}</span>
      </div>
      <div class="rep">${escapeHtml(truncate(c.representative, 600))}</div>
      <details>
        <summary>${c.examplePrompts.length} example prompts</summary>
        <div class="examples">
          ${c.examplePrompts.map((p) => `<p>${escapeHtml(truncate(p, 400))}</p>`).join('')}
        </div>
      </details>
    </div>`
    )
    .join('');
  wireUnhideEvents(container);
}

function wireUnhideEvents(scope) {
  for (const btn of scope.querySelectorAll('.btn-unhide')) {
    btn.addEventListener('click', () => unhideCluster(btn.dataset.cid));
  }
}
```

- [ ] **Step 3: Add CSS for the new card sub-elements**

Append to `src/dashboard/public/styles.css`:

```css
.rec-cluster-rep {
  margin-top: 10px;
  padding: 8px 10px;
  background: var(--bg);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: auto;
}
.rec-workspaces {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-dim);
}
.rec-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.btn-hide,
.btn-draft,
.btn-unhide,
.copy-btn,
.mark-created-btn {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.btn-hide:hover,
.btn-draft:hover,
.btn-unhide:hover,
.copy-btn:hover,
.mark-created-btn:hover {
  background: var(--bg-elev-2);
}
.mark-created-btn {
  margin-top: 12px;
  background: rgba(63, 185, 80, 0.12);
  border-color: var(--good);
  color: var(--good);
}
.scaffold-panel {
  margin-top: 12px;
  padding: 10px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.scaffold-summary {
  cursor: pointer;
  color: var(--text-dim);
  font-size: 12px;
}
.scaffold-body {
  margin-top: 10px;
}
.scaffold-block {
  margin-top: 12px;
}
.scaffold-block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.scaffold-block pre {
  background: var(--bg);
  padding: 10px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
  margin: 0;
}
.scaffold-loading {
  color: var(--text-dim);
  font-style: italic;
}
.hidden-clusters {
  margin-bottom: 12px;
  padding: 10px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.hidden-clusters summary {
  cursor: pointer;
  color: var(--text-dim);
  font-size: 12px;
}
.hidden-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hidden-entry {
  background: var(--bg);
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.hidden-entry .meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.hidden-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hidden-rep {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  margin-bottom: 6px;
}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/app.js src/dashboard/public/styles.css
git commit -m "feat(dashboard): inline cluster rep + feedback buttons + scaffold panel"
```

---

## Self-review notes

- **Spec coverage:** Every spec section maps to a task. Cluster identity → Task 1. Persistence → Task 2. Skill scaffolder extraction → Task 3. Recommendations engine wiring → Task 4. CLI mirror → Task 5. Server routes → Task 6. Dashboard UI → Task 7.
- **Placeholder scan:** No TBD/TODO markers in implementation steps. The TODO strings inside the SKILL.md scaffold body (`TODO — describe the procedure…`) are intentional artifacts of the user-facing scaffold output and match the existing CLI behavior.
- **Type/name consistency:**
  - `clusterIdFor`, `jaccard`, `findDenylistMatch` are imported in Task 4 with the exact names exported in Task 1.
  - `DenylistEntry`, `loadConfig`, `addDenylistEntry`, `removeDenylistEntry` are exported from Task 2 and imported in Tasks 4, 5, 6.
  - `buildSkillScaffold` is exported from Task 3 and imported in Task 6.
  - `runUndeny` is exported from Task 5's new `commands/undeny.ts` and imported in `cli.ts`.
- **Out-of-scope guardrails:** No changes to `time-of-day.ts`, `blocks.ts`, `aggregator.ts`, `commands/daily.ts`, `commands/week.ts`, `commands/blocks.ts`, `commands/workspaces.ts`, `commands/analyze.ts`, `commands/context.ts`, or any other CLI command not explicitly listed above.
