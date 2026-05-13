# Recommendation feedback loop (Slice B)

## Problem

The optimization recommendations panel surfaces skill candidates well, but the day-to-day feedback loop is broken:

1. **No way to suppress one-off clusters.** Some recurring "shapes" of prompts are dead-end iterations on a bad workflow rather than legitimate skill candidates. Today they keep getting flagged forever, drowning real recommendations.
2. **No way to record "I made this skill — stop suggesting it."** Users who act on a recommendation get re-flagged on every dashboard refresh.
3. **Acting on a recommendation requires scrolling.** The rec card shows a CLI string (`ti draft-skill --cluster N`) — to actually see the cluster's content you scroll to the "Skill candidates" panel at the bottom of the page.

## Goals

- Per-cluster 👎 button on every skill recommendation in the dashboard, persisting across runs.
- Per-cluster 👍 flow that opens an inline panel with the SKILL.md scaffold + polish prompt + copy buttons, plus a final "Mark as created — hide from future runs" action.
- Cluster representative + workspaces inlined into each skill rec card so the user doesn't need to scroll to act.
- CLI mirror: `ti recommend` honors the denylist by default; `ti recommend --show-hidden` to peek; `ti undeny <id>` to restore.
- Drift-tolerant denylist: a cluster is hidden if its content matches a previously denylisted cluster, even when the representative text shifts as new prompts join the cluster.

## Non-goals

- Inline-action surface for non-skill rec kinds (`hook`, `subagent`, `context`, `model`). They still render their existing `action` CLI strings. Slice C will deepen those.
- Rendering the SKILL.md scaffold as HTML (markdown-to-HTML). The user copies plain Markdown into their editor — no new rendering deps.
- Editing rec thresholds, severities, or text via the dashboard.
- A backend write API for arbitrary config keys. Only the cluster-feedback shape is exposed.
- Mobile/touch layout polish for the new buttons. Desktop only.

## Architecture

### Stable cluster identity

Cluster identity today is positional: `clusters[i]` and `i + 1` is the user-facing cluster number. Position changes between runs (clusters re-sort by tokens; new sessions add or merge prompts), so it's not a persistence-safe key.

We add two pieces:

- `id`: `sha1(normalized representative text).slice(0, 12)` — short, stable per representative text. Safe to include in URLs and CLI args.
- `trigrams`: `string[]` — the cluster representative's trigram set, copied out of the existing `PromptRecord.trigrams: Set<string>` from the clusterer. Already computed; we just expose it.

The `id` lets us match on exact rep text. The `trigrams` let us match across representative drift via the same Jaccard similarity the clusterer already uses (a denylisted cluster whose rep changes — because a longer prompt joined and became the new rep — still gets caught when its trigrams overlap >= 0.7 with a future cluster's).

Both are added to `PromptCluster` (the public type) and emitted by `clusterPrompts` in `src/core/prompt-clusterer.ts`.

### Persistence

A single config file at `~/.token-insight.json`. New module `src/core/config.ts` is the only reader/writer. Defaults on missing or corrupt files; never throws on read errors. Atomic write via temp-file + rename.

Shape:

```json
{
  "clusterDenylist": [
    {
      "id": "abc123def456",
      "reason": "denied",
      "repExcerpt": "first 200 chars of the rep, for human review",
      "trigrams": ["abc", "bcd", "cde", "..."],
      "addedAt": "2026-04-27T18:21:54.000Z"
    }
  ]
}
```

Two valid `reason` values: `"denied"` (👎 — one-off) and `"created"` (👍-then-finalize — user made the skill). Functionally equivalent for filtering; the distinction is for review/audit.

`Config` interface exported from `config.ts`:

```ts
export interface DenylistEntry {
  id: string;
  reason: 'denied' | 'created';
  repExcerpt: string;
  trigrams: string[];
  addedAt: string; // ISO
}

export interface TokenInsightConfig {
  clusterDenylist: DenylistEntry[];
}

export function loadConfig(): Promise<TokenInsightConfig>;
export function saveConfig(c: TokenInsightConfig): Promise<void>;
export function addDenylistEntry(entry: DenylistEntry): Promise<void>;
export function removeDenylistEntry(id: string): Promise<boolean>;
```

A read-through cache (single in-memory copy with a generation counter) keeps the dashboard server fast across repeated requests; writes invalidate the cache.

### Filtering

New module `src/core/cluster-id.ts` exports:

```ts
export function clusterIdFor(normalizedRep: string): string;
export function trigramsOf(s: string): string[]; // ordered output of the normalized rep
export function jaccard(a: string[] | Set<string>, b: string[] | Set<string>): number;
export function isDenylisted(
  cluster: { id: string; trigrams: string[] },
  denylist: DenylistEntry[],
  similarityThreshold?: number
): DenylistEntry | null;
```

`isDenylisted`:
- Returns the matching entry if `cluster.id` equals any entry's `id`.
- Otherwise, returns the first entry whose `trigrams` have Jaccard similarity ≥ threshold (default 0.7) to `cluster.trigrams`.
- Returns `null` if no match.

The recommendations engine consumes this via a new optional input on `RecommendInputs`:

```ts
export interface RecommendInputs {
  ...
  denylist?: DenylistEntry[];
  includeHidden?: boolean;
}
```

When `includeHidden` is true, denylisted clusters still appear, with their hidden status surfaced via a new evidence field. When false (the default), denylisted clusters are skipped.

### Skill scaffolder extraction

`buildSkillBody`, `buildPolishPrompt`, and `makeSlug` move out of `src/commands/draft-skill.ts` into a new `src/core/skill-scaffold.ts` module. Public surface:

```ts
export interface SkillScaffold {
  slug: string;
  skillBody: string;     // Markdown, ready to write to <slug>-SKILL.md
  polishPrompt: string;  // Markdown, ready to paste into Claude Code
}

export function buildSkillScaffold(cluster: PromptCluster): SkillScaffold;
```

`draft-skill.ts` imports `buildSkillScaffold` and replaces its inline definitions. The dashboard server calls the same function. No behavior change for the existing CLI command.

### Dashboard server

Three new routes on the existing Express app in `src/dashboard/server.ts`:

- `POST /api/cluster/:id/deny` — body `{ reason: 'denied' | 'created' }`. Looks up the cluster from the most recent computed report; if found, calls `addDenylistEntry` with the cluster's `id`, `repExcerpt` (first 200 chars), `trigrams`, and `addedAt: new Date().toISOString()`. Invalidates the report cache. Returns `{ ok: true }`.
- `DELETE /api/cluster/:id/deny` — calls `removeDenylistEntry(id)`. Invalidates the report cache. Returns `{ ok: true, removed: <bool> }`.
- `GET /api/cluster/:id/scaffold` — looks up the cluster, calls `buildSkillScaffold`, returns `{ slug, skillBody, polishPrompt }`. No cache invalidation.

The existing `/api/report` already runs through `clusterPrompts` and `buildRecommendations`. Augment it to:
1. Load the config's `clusterDenylist`.
2. Pass it to `buildRecommendations` as `denylist` (default-filter mode).
3. Include the denylist itself in the JSON response so the UI can render a "Hidden (N) — show" toggle in the cluster panel.

The cache TTL stays at 10s. Manual invalidation paths: any successful deny/undeny POST/DELETE.

### Dashboard UI

In `src/dashboard/public/index.html`, the recommendations container (`#recs-list`) keeps its current outer markup. Per-card rendering changes inside `app.js:renderRecommendations`:

For recs with `kind === 'skill'`:

```
┌────────────────────────────────────────────────┐
│ HIGH | Turn this into a skill — repeated 50×   │  <- existing
│      | [skill]                                  │
│      | You've made 50 similar requests…         │  <- existing body
│      | ┌──────────────────────────────────────┐ │
│      | │ "representative prompt excerpt …"    │ │  <- NEW: inline rep
│      | └──────────────────────────────────────┘ │
│      | workspaces: token-insight, foo, bar     │  <- NEW: inline workspaces
│      |                                          │
│      | [👎 Hide] [👍 Draft skill]               │  <- NEW: feedback buttons
│      |                                          │
│      | ▼ Draft skill (collapsed by default)    │  <- NEW: <details> panel
│      |   ┌─ SKILL.md scaffold ──────────────┐  │
│      |   │ ---                               │  │
│      |   │ name: ...                         │  │
│      |   │ ...                               │  │
│      |   │                                   │  │
│      |   │ [📋 Copy]                         │  │
│      |   └───────────────────────────────────┘  │
│      |   ┌─ Polish prompt ──────────────────┐  │
│      |   │ # Polish this skill draft        │  │
│      |   │ ...                               │  │
│      |   │ [📋 Copy]                         │  │
│      |   └───────────────────────────────────┘  │
│      |   [✓ Mark as created — hide from runs] │
└────────────────────────────────────────────────┘
```

- The 👍 button toggles the `<details>` panel open and (lazily on first open) fetches `GET /api/cluster/:id/scaffold` to populate the two `<pre>` blocks. Loading state is a "Loading scaffold…" placeholder.
- Copy buttons use `navigator.clipboard.writeText`. Briefly flash "Copied!" inline.
- 👎 and "Mark as created" both POST `/api/cluster/:id/deny` (with `reason` set accordingly). On success, the card visually fades and is removed; the user can re-open the dashboard to confirm it stays hidden.
- The cluster id is read from `r.evidence.clusterId` (added to the rec's evidence by `recommendations.ts`).

For recs without a cluster id (non-skill kinds), the layout is unchanged.

The bottom "Skill candidates" panel keeps its existing render. Add a small toggle row above it: `Hidden (N) [show]`. Toggling re-fetches `/api/report?showHidden=1` and re-renders. Each hidden cluster gets a small "↺ unhide" button that DELETEs the denylist entry.

CSS additions live in `styles.css` under a new section. New classes: `.rec-cluster-rep`, `.rec-workspaces`, `.rec-actions`, `.btn-hide`, `.btn-draft`, `.scaffold-panel`, `.scaffold-block`, `.copy-btn`, `.mark-created-btn`.

### CLI

`src/commands/recommend.ts`:
- Loads the config's denylist before calling `buildRecommendations`.
- Adds `--show-hidden` option to include denylisted entries.
- When showing hidden entries, prefixes the title with `[hidden: <reason>]`.

New file `src/commands/undeny.ts` with signature `runUndeny(id: string): Promise<void>`. Looks up the entry by exact id (or prefix if unique), removes it via `removeDenylistEntry`, prints confirmation.

New CLI registration in `src/cli.ts`:

```ts
program
  .command('undeny <id>')
  .description('Remove a cluster from the denylist (rerun ti recommend --show-hidden to find ids)')
  .action(async (id) => { await runUndeny(id); });
```

## Data flow

```
JSONL → loadAllSessions → clusterPrompts → clusters: PromptCluster[] (now with id, trigrams)
                                       ↓
                            loadConfig → denylist: DenylistEntry[]
                                       ↓
                            buildRecommendations(inputs+denylist+includeHidden)
                                       ↓
                            recs: Recommendation[]   (each skill rec carries clusterId)
                                       ↓
            ┌─────────────── /api/report → dashboard renders cards ─────────────┐
            ↓                                                                    ↓
     `ti recommend` (CLI)                                              click 👍 → GET /api/cluster/:id/scaffold
                                                                                 ↓
                                                                       buildSkillScaffold(cluster)
```

Writes:
```
click 👎 / Mark as created → POST /api/cluster/:id/deny → addDenylistEntry → atomic write ~/.token-insight.json → cache invalidate
click ↺ unhide / `ti undeny <id>` → removeDenylistEntry → atomic write → cache invalidate
```

## Files touched

**New**
- `src/core/config.ts` — read/write/cache `~/.token-insight.json`.
- `src/core/cluster-id.ts` — `clusterIdFor`, `trigramsOf`, `jaccard`, `isDenylisted`.
- `src/core/skill-scaffold.ts` — extracted `buildSkillBody` + `buildPolishPrompt` + `makeSlug` + `buildSkillScaffold`.
- `src/commands/undeny.ts` — `runUndeny`.

**Modified**
- `src/core/types.ts` — add `id` and `trigrams: string[]` to `PromptCluster`.
- `src/core/prompt-clusterer.ts` — emit `id` and `trigrams` in cluster output.
- `src/core/recommendations.ts` — accept optional `denylist` and `includeHidden`; filter clusters; include `clusterId` in skill rec evidence.
- `src/dashboard/server.ts` — POST/DELETE `/api/cluster/:id/deny`, GET `/api/cluster/:id/scaffold`. Pipe denylist into `/api/report`. Cache invalidation hooks.
- `src/dashboard/public/index.html` — minor: a wrapper for the hidden-clusters toggle in the bottom skill-candidates panel.
- `src/dashboard/public/app.js` — render rec cards with rep + workspaces + buttons + scaffold panel; deny/undeny POSTs; clipboard copy; hidden-clusters toggle.
- `src/dashboard/public/styles.css` — new card sub-element classes.
- `src/commands/recommend.ts` — load config, filter, add `--show-hidden`.
- `src/commands/draft-skill.ts` — replace inline scaffold builders with `buildSkillScaffold` import.
- `src/cli.ts` — register `undeny` command.

## Verification

This project has no unit test framework. Verification:

1. `npm run typecheck` passes.
2. **Cluster identity stability**: run `npx tsx -e "..."` to confirm `clusterIdFor` is deterministic for the same input and `jaccard(setA, setB)` returns expected values for hand-crafted inputs.
3. **End-to-end dashboard flow**:
   - `ti` opens the dashboard. A skill rec shows the embedded representative + workspaces.
   - Click 👎 on a skill rec → card disappears optimistically. Reload page → still gone. `cat ~/.token-insight.json` → entry present with `reason: "denied"`.
   - Click 👍 on another skill rec → panel opens, scaffold + polish prompt populate within ~1s.
   - Click 📋 on the scaffold → clipboard contains the SKILL.md body (verify by pasting into a blank file).
   - Click "Mark as created" → card disappears. `cat ~/.token-insight.json` → entry has `reason: "created"`.
   - Click "Hidden (2) — show" toggle → both denylisted entries appear with hidden badges and ↺ unhide buttons.
   - Click ↺ unhide → entry returns to active recommendations. Reload → still active.
4. **CLI mirror**:
   - `ti recommend` lists fewer skill recs (denylisted ones absent).
   - `ti recommend --show-hidden` lists everything; hidden entries prefixed with `[hidden: …]`.
   - `ti undeny <id>` removes; subsequent `ti recommend` re-shows the rec.
5. **Drift tolerance**: After denylisting a cluster, manually edit `~/.token-insight.json` to give the entry a slightly different `repExcerpt` (simulating drift); confirm the cluster is still hidden via Jaccard match on the unchanged `trigrams`.
6. **Existing CLI unchanged**: `ti draft-skill --cluster 1` still writes a SKILL.md and polish prompt to disk (the refactor preserves behavior).

## Risks

- **Concurrent writes** to `~/.token-insight.json` from two `ti` instances could race. Atomic temp-file + rename keeps the file from being half-written, but a write that started before another's read can be lost. Acceptable for a single-user tool.
- **Trigram bloat in config**: each denylist entry adds ~1KB of trigrams. Hundreds of entries is fine; thousands would balloon the file. Practical cap is well above expected use.
- **Stable id collisions**: 12-char sha1 prefix has ~2^48 namespace. Effectively zero collision risk for the expected scale (<1000 clusters lifetime).
- **`navigator.clipboard.writeText`** requires a secure context. `localhost` is treated as secure — fine for the local dashboard.

## Out of scope

- Slice C (phase-2 optimization signals: hook depth, subagent depth, out-of-context workspace flag). Tracked separately.
- Telemetry on which clusters get hidden vs created vs left untouched.
- A "history" view of past denylist actions.
- Bulk operations (deny multiple at once).
