# Skill Catalog Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect prompt clusters that match the user's installed skills (Jaccard ≥ 0.2 against parsed `description:` frontmatter) and emit "use existing skill" recs instead of "create new skill" recs. Add a per-session subagent rec for sessions with heavy upfront Read/Glob/Grep activity and no `Task` use.

**Architecture:** New `src/core/skill-catalog.ts` walks `~/.claude/plugins/cache/**`, `~/.claude/skills/**`, and per-workspace `.claude/skills/**` to build a list of `{ name, description, label, source, skillPath, descriptionTrigrams }`. Existing `normalize` and `trigramsOf` from `prompt-clusterer.ts` are promoted to exports so the catalog and the matcher share normalization. `skillRecs` in `recommendations.ts` consults the catalog after the size/tokens/denylist guards; a match swaps the title and body, includes the skill path in evidence, and disables the inline scaffold panel for that card. New `sessionSubagentRecs` flags individual sessions whose pre-edit `Read`/`Glob`/`Grep` count exceeds 15 with no `Task` invocation. Dashboard UI conditionally renders a matched-skill block when `evidence.matchedSkill` is present.

**Tech Stack:** TypeScript, Node 18+, Express, vanilla browser JS. No new dependencies; YAML frontmatter parsed by a minimal purpose-built parser.

**Spec:** [`docs/superpowers/specs/2026-04-27-skill-catalog-match-design.md`](../specs/2026-04-27-skill-catalog-match-design.md)

---

### Task 1: Promote normalize/trigramsOf + create skill-catalog module

**Files:**
- Modify: `src/core/prompt-clusterer.ts`
- Create: `src/core/skill-catalog.ts`

- [ ] **Step 1: Promote `normalize` and `trigramsOf` exports**

In `src/core/prompt-clusterer.ts`, find the two helpers (currently `function normalize(s: string): string` around line 137 and `function trigramsOf(s: string): Set<string>` around line 155). Add the `export` keyword to both:

```typescript
export function normalize(s: string): string {
```

```typescript
export function trigramsOf(s: string): Set<string> {
```

No body changes. The internal callers continue to use them locally.

- [ ] **Step 2: Create `src/core/skill-catalog.ts`**

```typescript
// Discovers SKILL.md files installed on the user's machine and parses just
// enough YAML frontmatter to pull `name:` and `description:`. Used by the
// recommendations engine to detect when a recurring prompt cluster matches a
// skill the user already has installed.
//
// Three roots are walked, in this order:
//   1. ~/.claude/plugins/cache/<owner>/<plugin>/<version>/skills/<skill>/SKILL.md
//   2. ~/.claude/skills/<skill>/SKILL.md
//   3. <workspacePath>/.claude/skills/<skill>/SKILL.md (per workspace)
//
// `temp_git_*` plugin cache directories are skipped — they are transient
// install-time checkouts, not real installed skills.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalize, trigramsOf } from './prompt-clusterer.js';

export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: 'plugin' | 'global' | 'workspace';
  /** Display label, e.g. "superpowers:brainstorming", "user:session-wrap", "ws:token-insight/foo" */
  label: string;
  skillPath: string;
  descriptionTrigrams: string[];
}

export async function loadSkillCatalog(workspacePaths: string[]): Promise<SkillCatalogEntry[]> {
  const out: SkillCatalogEntry[] = [];
  const home = os.homedir();
  await collectPlugins(path.join(home, '.claude', 'plugins', 'cache'), out);
  await collectGlobal(path.join(home, '.claude', 'skills'), out);
  for (const ws of workspacePaths) {
    await collectWorkspace(ws, out);
  }
  return out;
}

async function safeReaddir(dir: string): Promise<{ name: string; isDir: boolean }[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: { name: string; isDir: boolean }[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      out.push({ name: e.name, isDir: e.isDirectory() });
    }
    return out;
  } catch {
    return [];
  }
}

/** ~/.claude/plugins/cache/<owner>/<plugin>/<version>/skills/<skill>/SKILL.md */
async function collectPlugins(root: string, out: SkillCatalogEntry[]): Promise<void> {
  for (const owner of await safeReaddir(root)) {
    if (!owner.isDir) continue;
    if (owner.name.startsWith('temp_git_')) continue;
    const ownerDir = path.join(root, owner.name);
    for (const plugin of await safeReaddir(ownerDir)) {
      if (!plugin.isDir) continue;
      const pluginDir = path.join(ownerDir, plugin.name);
      for (const version of await safeReaddir(pluginDir)) {
        if (!version.isDir) continue;
        const skillsDir = path.join(pluginDir, version.name, 'skills');
        for (const skill of await safeReaddir(skillsDir)) {
          if (!skill.isDir) continue;
          const skillFile = path.join(skillsDir, skill.name, 'SKILL.md');
          await pushIfValid(skillFile, 'plugin', `${plugin.name}:${skill.name}`, out);
        }
      }
    }
  }
}

/** ~/.claude/skills/<skill>/SKILL.md */
async function collectGlobal(root: string, out: SkillCatalogEntry[]): Promise<void> {
  for (const skill of await safeReaddir(root)) {
    if (!skill.isDir) continue;
    const skillFile = path.join(root, skill.name, 'SKILL.md');
    await pushIfValid(skillFile, 'global', `user:${skill.name}`, out);
  }
}

/** <workspacePath>/.claude/skills/<skill>/SKILL.md */
async function collectWorkspace(workspacePath: string, out: SkillCatalogEntry[]): Promise<void> {
  const skillsRoot = path.join(workspacePath, '.claude', 'skills');
  const wsName = path.basename(workspacePath) || workspacePath;
  for (const skill of await safeReaddir(skillsRoot)) {
    if (!skill.isDir) continue;
    const skillFile = path.join(skillsRoot, skill.name, 'SKILL.md');
    await pushIfValid(skillFile, 'workspace', `ws:${wsName}/${skill.name}`, out);
  }
}

async function pushIfValid(
  skillFile: string,
  source: SkillCatalogEntry['source'],
  label: string,
  out: SkillCatalogEntry[]
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(skillFile, 'utf8');
  } catch {
    return;
  }
  const fm = parseFrontmatter(raw);
  if (!fm.name || !fm.description) return;
  const normalized = normalize(fm.description);
  const trigrams = [...trigramsOf(normalized)];
  if (trigrams.length === 0) return;
  out.push({
    name: fm.name,
    description: fm.description,
    source,
    label,
    skillPath: skillFile,
    descriptionTrigrams: trigrams,
  });
}

/**
 * Minimal YAML frontmatter reader. Recognizes a leading `---` line and the
 * matching closing `---` line. Pulls single-line `name:` and `description:`
 * scalars (unquoted, single-quoted, or double-quoted). Anything fancier
 * (block scalars, nested keys) returns empty for the affected field.
 */
export function parseFrontmatter(raw: string): { name: string; description: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: '', description: '' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { name: '', description: '' };
  let name = '';
  let description = '';
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
  }
  return { name, description };
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Sanity probes**

From `/Users/johnmarchisin/conductor/workspaces/token-insight/karachi`:

```bash
npx tsx -e "
  import { loadSkillCatalog } from './src/core/skill-catalog.ts';
  (async () => {
    const c = await loadSkillCatalog([]);
    console.log('found:', c.length);
    const labels = c.map(e => e.label).sort();
    console.log('first 6:', labels.slice(0, 6).join(', '));
    const sw = c.find(e => e.label === 'user:session-wrap');
    console.log('session-wrap present:', !!sw);
    if (sw) console.log('session-wrap trigrams:', sw.descriptionTrigrams.length);
  })();
"
```

Expected:
- `found:` is a non-zero number (depends on user's installed skills; should be at least a few dozen given the Conductor + superpowers plugins).
- `first 6` shows labels prefixed with `user:`, `superpowers:`, etc.
- `session-wrap present: true` (the user has this global skill).
- A non-zero trigram count.

```bash
npx tsx -e "
  import { parseFrontmatter } from './src/core/skill-catalog.ts';
  const sample = '---\nname: foo\ndescription: \"Hello world\"\n---\n# body';
  console.log(parseFrontmatter(sample));
  const noFm = '# just markdown\nbody';
  console.log(parseFrontmatter(noFm));
  const unclosed = '---\nname: x\nbody without close';
  console.log(parseFrontmatter(unclosed));
"
```

Expected:
```
{ name: 'foo', description: 'Hello world' }
{ name: '', description: '' }
{ name: '', description: '' }
```

- [ ] **Step 5: Commit**

```bash
git add src/core/prompt-clusterer.ts src/core/skill-catalog.ts
git commit -m "feat(catalog): discover installed skills and parse frontmatter"
```

---

### Task 2: Wire catalog matching + per-session subagent into recommendations

**Files:**
- Modify: `src/core/recommendations.ts`

- [ ] **Step 1: Update imports**

At the top of `src/core/recommendations.ts`, after the existing `import { findDenylistMatch } from './cluster-id.js';` line, add:

```typescript
import { SkillCatalogEntry } from './skill-catalog.js';
import { jaccard } from './cluster-id.js';
```

(`jaccard` is already exported from `cluster-id.ts` from Slice B.)

- [ ] **Step 2: Add tunable constants**

Add these exports near the top of the file, right after `export type RecSeverity = 'high' | 'medium' | 'low';`:

```typescript
export const SKILL_MATCH_JACCARD = 0.2;
export const SUBAGENT_EXPLORE_MIN = 15;
```

- [ ] **Step 3: Add `skillCatalog?` to `RecommendInputs`**

Append `skillCatalog?: SkillCatalogEntry[];` to the interface (after the existing `includeHidden?` field added in Slice B).

- [ ] **Step 4: Wire the catalog into `buildRecommendations`**

Find the `recs.push(...skillRecs(...))` call. Replace with:

```typescript
recs.push(...skillRecs(inputs.clusters, inputs.denylist ?? [], inputs.includeHidden ?? false, inputs.skillCatalog ?? []));
```

Find the `recs.push(...subagentRecs(inputs.sessions))` call. ABOVE it, add:

```typescript
recs.push(...sessionSubagentRecs(inputs.sessions));
```

(So the per-session detector runs before the workspace-rollup detector in the recs list.)

- [ ] **Step 5: Restructure `skillRecs` to consult the catalog**

Replace the entire `skillRecs` function with:

```typescript
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

    if (matched) {
      out.push({
        kind: 'skill',
        severity: c.totalTokens > 500_000 ? 'high' : c.size >= 5 ? 'medium' : 'low',
        title: `${titlePrefix}Existing skill matches — ${matched.entry.label} — make it more available`,
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
      title: `${titlePrefix}Turn this into a skill — repeated ${c.size}× across ${c.workspaces.length} workspace(s)`,
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

interface SkillMatch {
  entry: SkillCatalogEntry;
  similarity: number;
}

function bestSkillMatch(clusterTrigrams: string[], catalog: SkillCatalogEntry[]): SkillMatch | null {
  let best: SkillMatch | null = null;
  for (const entry of catalog) {
    if (entry.descriptionTrigrams.length === 0) continue;
    const sim = jaccard(clusterTrigrams, entry.descriptionTrigrams);
    if (sim < SKILL_MATCH_JACCARD) continue;
    if (!best || sim > best.similarity) best = { entry, similarity: sim };
  }
  return best;
}
```

- [ ] **Step 6: Add `sessionSubagentRecs`**

Add this function below the existing `subagentRecs`:

```typescript
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
```

(Note the indentation on `evidence:` — it's inside the object literal returned to `.map`. Fix any leading-space inconsistency the editor introduces.)

- [ ] **Step 7: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add src/core/recommendations.ts
git commit -m "feat(recommendations): match clusters to installed skills + per-session subagent"
```

---

### Task 3: Wire catalog into the dashboard server and CLI

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/commands/recommend.ts`

- [ ] **Step 1: Dashboard server — load catalog**

In `src/dashboard/server.ts`, add the import after the existing config / skill-scaffold imports:

```typescript
import { loadSkillCatalog } from '../core/skill-catalog.js';
```

Find the `Promise.all([...])` block in `getReport` (the one with `inspectAllWorkspaces`, `inspectGlobal`, `aggregateFileReads`, `loadConfig`). Add a fifth entry. Before:

```typescript
const [contextReports, globalContext, fileReads, config] = await Promise.all([
  inspectAllWorkspaces(sessions),
  inspectGlobal(),
  aggregateFileReads(sessions),
  loadConfig(),
]);
```

After:

```typescript
const workspacePaths = [...new Set(sessions.map((s) => s.workspacePath))];
const [contextReports, globalContext, fileReads, config, skillCatalog] = await Promise.all([
  inspectAllWorkspaces(sessions),
  inspectGlobal(),
  aggregateFileReads(sessions),
  loadConfig(),
  loadSkillCatalog(workspacePaths),
]);
```

Update the `buildRecommendations({...})` call to include `skillCatalog`:

```typescript
const recommendations = buildRecommendations({
  sessions,
  clusters,
  contextReports,
  globalContext,
  fileReads,
  denylist: config.clusterDenylist,
  skillCatalog,
});
```

- [ ] **Step 2: CLI — load catalog**

In `src/commands/recommend.ts`, add the import after the existing `import { loadConfig } from '../core/config.js';` line:

```typescript
import { loadSkillCatalog } from '../core/skill-catalog.js';
```

Update the `Promise.all` (currently has 4 entries):

```typescript
const workspacePaths = [...new Set(sessions.map((s) => s.workspacePath))];
const [contextReports, globalContext, fileReads, config, skillCatalog] = await Promise.all([
  inspectAllWorkspaces(sessions),
  inspectGlobal(),
  aggregateFileReads(sessions),
  loadConfig(),
  loadSkillCatalog(workspacePaths),
]);
```

Update the `buildRecommendations({...})` call:

```typescript
let recs = buildRecommendations({
  sessions,
  clusters,
  contextReports,
  globalContext,
  fileReads,
  denylist: config.clusterDenylist,
  includeHidden: opts.showHidden ?? false,
  skillCatalog,
});
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Sanity probe — `ti recommend --kind skill` should now list catalog matches**

From `/Users/johnmarchisin/conductor/workspaces/token-insight/karachi`:

```bash
npx tsx src/cli.ts recommend --kind skill 2>&1 | head -40
```

Look for at least one rec whose title starts with `Existing skill matches —`. (If none appear, the user genuinely has no clusters that overlap their installed skill descriptions — the wider Slice C is still working; this is just a real-data observation.)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.ts src/commands/recommend.ts
git commit -m "feat: load skill catalog and pipe into recommendations"
```

---

### Task 4: Dashboard UI — render matched-skill block

**Files:**
- Modify: `src/dashboard/public/app.js`
- Modify: `src/dashboard/public/styles.css`

- [ ] **Step 1: Update `recCardHtml` in `app.js`**

Locate `recCardHtml(r)` (added in Slice B). Replace with this version that handles the matched-skill case:

```javascript
function recCardHtml(r) {
  const cid = r.evidence && r.evidence.clusterId ? String(r.evidence.clusterId) : '';
  const isSkill = r.kind === 'skill' && cid;
  const matched = isSkill && r.evidence && r.evidence.matchedSkill ? r.evidence.matchedSkill : null;
  const rep = isSkill ? truncate(r.evidence.representative || '', 320) : '';
  const ws = isSkill && Array.isArray(r.evidence.workspaces) ? r.evidence.workspaces.join(', ') : '';
  const inlineRep = isSkill
    ? `<div class="rec-cluster-rep">"${escapeHtml(rep)}"</div>
       ${ws ? `<div class="rec-workspaces">workspaces: ${escapeHtml(ws)}</div>` : ''}`
    : '';
  const matchedBlock = matched
    ? `<div class="matched-skill">
         <div class="matched-skill-head">matched skill: <strong>${escapeHtml(matched.label)}</strong> <span class="matched-skill-source">(${escapeHtml(matched.source)})</span></div>
         <code class="matched-skill-path">${escapeHtml(matched.skillPath)}</code>
       </div>`
    : '';
  const actions = isSkill
    ? matched
      ? `<div class="rec-actions">
           <button class="btn-hide" data-cid="${escapeHtml(cid)}" title="Hide — irrelevant match">👎 Hide</button>
         </div>`
      : `<div class="rec-actions">
           <button class="btn-hide" data-cid="${escapeHtml(cid)}" title="Hide — one-off, don't suggest again">👎 Hide</button>
           <button class="btn-draft" data-cid="${escapeHtml(cid)}" title="Open the SKILL.md scaffold">👍 Draft skill</button>
         </div>
         <details class="scaffold-panel" data-cid="${escapeHtml(cid)}" data-loaded="0">
           <summary class="scaffold-summary">Skill scaffold</summary>
           <div class="scaffold-body"><p class="scaffold-loading">Loading scaffold…</p></div>
         </details>`
    : '';
  return `
    <div class="rec ${r.severity}"${cid ? ` data-cid="${escapeHtml(cid)}"` : ''}>
      <div class="severity">${r.severity}</div>
      <div class="body">
        <div class="title">${escapeHtml(r.title)}<span class="kind">${escapeHtml(r.kind)}</span></div>
        <div class="desc">${escapeHtml(r.body)}</div>
        ${inlineRep}
        ${matchedBlock}
        ${r.action && !isSkill ? `<div class="action">${escapeHtml(r.action)}</div>` : ''}
        ${r.action && matched ? `<div class="action">${escapeHtml(r.action)}</div>` : ''}
        ${actions}
      </div>
    </div>`;
}
```

Key changes from Slice B's version:
- Reads `r.evidence.matchedSkill` into `matched`.
- Renders a new `.matched-skill` block (label, source, skill path) above the action block.
- For matched recs: shows only the 👎 button (no scaffold panel — there's no scaffold to show for an existing skill).
- For matched recs: shows the `code <skillPath>` action.

- [ ] **Step 2: Append CSS for the matched-skill block**

Append to `src/dashboard/public/styles.css`:

```css
.matched-skill {
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(63, 185, 80, 0.08);
  border: 1px solid rgba(63, 185, 80, 0.3);
  border-radius: 4px;
}
.matched-skill-head {
  font-size: 12px;
  color: var(--text);
  margin-bottom: 4px;
}
.matched-skill-source {
  color: var(--text-dim);
  font-weight: 400;
}
.matched-skill-path {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-dim);
  word-break: break-all;
  background: var(--bg);
  padding: 4px 6px;
  border-radius: 3px;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/app.js src/dashboard/public/styles.css
git commit -m "feat(dashboard): render matched-skill block on existing-skill recs"
```

---

## Self-review notes

- **Spec coverage:** Catalog discovery + frontmatter parser (Task 1), match logic + per-session subagent (Task 2), wiring through server + CLI (Task 3), dashboard rendering (Task 4). All sections of the spec map to a task.
- **Placeholder scan:** None — every code block is complete.
- **Type/name consistency:** `SkillCatalogEntry`, `loadSkillCatalog`, `parseFrontmatter` are exported in Task 1 and consumed by name in Tasks 2 and 3. `SKILL_MATCH_JACCARD`, `SUBAGENT_EXPLORE_MIN` are exported in Task 2 (no other code reads them, just tunable knobs). `matchedSkill` evidence shape is consistent between Task 2 (emit) and Task 4 (consume).
- **Out-of-scope guardrails:** No changes to `prompt-clusterer.ts` beyond promoting two helpers; no changes to `aggregator.ts`, `blocks.ts`, `time-of-day.ts`, `context-inspector.ts`, or any other CLI command not listed.
