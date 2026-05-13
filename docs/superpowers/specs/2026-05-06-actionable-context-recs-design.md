# Actionable CLAUDE.md context recommendations (v1)

**Date:** 2026-05-06
**Status:** Approved for implementation

## Problem

The dashboard's "CLAUDE.md bloat" reporting is correctly *detecting* bloat but produces unactionable recs. Users see "trim CLAUDE.md, context overhead is high" with no pointer to *what* to trim. A recent manual context audit across 7+ workspaces (`.context/attachments/pasted_text_2026-05-06_09-17-56.txt`) produced concrete findings — "Recent Changes" sections eating tokens, 19-flow org snapshots inlined, `.claude/shared/` duplicates across 8 worktrees — and reduced workspace CLAUDE.md size by ~67% on average. The dashboard should automate this style of finding.

The inspector also captures `lastModified` per file but never uses it, so workspaces where the doc has drifted out of date relative to active session activity go unflagged.

## Goals (v1)

1. **Decaying-state heading detector** — flag `##`+ headings inside CLAUDE.md whose names suggest mutable state ("Recent Changes", "Next Steps", "Status", "TODO", etc.). Each match becomes a per-section finding with line range and token cost. The fix is always the same: move to `docs/STATUS.md` (or another canonical living doc).

2. **Staleness + drift detection** — using `mtime` (already captured) and existing session timestamps:
   - **Stale** — CLAUDE.md not edited in 60+ days (low signal — could just be a stable workspace)
   - **Drifting** — mtime older than 30 days *and* 5+ sessions in that workspace since the last edit (high signal — the doc hasn't kept up with active work)

3. **Per-workspace findings card on the dashboard** — replace the current bare table (workspace / lines / tokens / issue-count) with a card per workspace that lists the *specific* findings, each with an inline action hint.

## Non-goals (parked for follow-up)

- Cross-workspace duplication detection (chunk + hash + cross-reference)
- Generated-block detector (long contiguous tabular runs that look like CLI output)
- Doc-index gap detector (workspace has substantive `docs/*.md` but CLAUDE.md doesn't reference them)
- Falsifiable-claim detection (e.g. "no STATUS doc yet" while one exists)

## Design

### 1. Data model — `src/core/context-inspector.ts`

Extend `ContextReport` (additive only; existing fields unchanged):

```ts
export interface DecayingSection {
  fromFile: string;
  heading: string;          // e.g. "Recent Changes"
  startLine: number;        // 1-indexed line of the heading
  endLine: number;          // 1-indexed last line of the section (exclusive of next heading)
  lineCount: number;
  estimatedTokens: number;
}

export interface ContextReport {
  // existing:
  workspacePath: string;
  workspaceName: string;
  files: ContextFile[];
  totalEstimatedTokens: number;
  missingImports: MissingImport[];
  bulkyImports: BulkyImport[];
  // new:
  decayingSections: DecayingSection[];
  daysSinceModified?: number;     // undefined if no CLAUDE.md found or mtime unavailable
  recentSessionCount: number;     // sessions in this workspace whose endTime > newest CLAUDE.md mtime
  isStale: boolean;               // daysSinceModified !== undefined && daysSinceModified > STALE_DAYS
  isDrifting: boolean;            // daysSinceModified !== undefined && daysSinceModified > DRIFT_DAYS && recentSessionCount >= DRIFT_SESSIONS
}
```

`GlobalContextReport` does **not** get `decayingSections`, staleness, or drift — global CLAUDE.md is hand-curated, no per-workspace mtime comparison applies.

### 2. Detection logic

Constants live at the top of `context-inspector.ts`:

```ts
const STALE_DAYS = 60;
const DRIFT_DAYS = 30;
const DRIFT_SESSIONS = 5;

const DECAYING_HEADING_PATTERNS: RegExp[] = [
  /^#{2,}\s+(recent\s+\w+|current\s+\w+|next\s+steps?|in\s+progress|todo|last\s+updated|status|activity|recent\s+activity|known\s+issues|quick\s+wins|future\s+work)\b/i,
];
```

**Heading scan** (`extractDecayingSections(content: string, fromFile: string): DecayingSection[]`):
- Walk lines; for each `^#{2,}\s` heading whose text matches any pattern in `DECAYING_HEADING_PATTERNS`, find the section's end:
  - The next line that begins a heading of the same-or-higher level (fewer-or-equal `#` chars), OR EOF
- Compute `lineCount = endLine - startLine + 1`, `estimatedTokens = byteCount * TOKEN_PER_BYTE_ESTIMATE` (reuse existing constant)
- H1 (`# Foo`) is intentionally **excluded** — that's the file title; flagging it would always fire and add no value

**Drift / staleness** — computed inside `inspectWorkspace`:
- `mtime` = max `lastModified` across the `ContextFile`s found (covers both `CLAUDE.md` and `CLAUDE.local.md`)
- `daysSinceModified = (Date.now() - mtime) / 86_400_000` rounded to integer; undefined if no files have mtime
- `recentSessionCount` = count of sessions belonging to this workspace whose `endTime > mtime`
- `isStale`, `isDrifting` per the formulas above

`inspectAllWorkspaces` signature changes:

```ts
// before
export async function inspectAllWorkspaces(sessions: Session[]): Promise<ContextReport[]>
// after — same signature, but sessions are now actually used
```

The function already receives `sessions`; today it only uses them to enumerate workspace paths. We additionally pass them through to `inspectWorkspace` (which gains a `sessions: Session[]` parameter, filtered internally to that workspace) so it can compute `recentSessionCount`.

### 3. Recommendations — `src/core/recommendations.ts`

`contextRecs` gains three new emitters. Existing recs (global bloat, workspace bloat, missing imports, bulky imports) keep firing unchanged.

**Per decaying section** (one rec per section, severity by size):

```ts
{
  kind: 'context',
  severity: section.lineCount > 40 ? 'medium' : 'low',
  title: `${ws}: '${section.heading}' section in CLAUDE.md (lines ${section.startLine}-${section.endLine}, ~${formatTokens(section.estimatedTokens)} tok)`,
  body: `This section reads like decaying state — content that goes stale between edits and pays a token tax on every prompt in this workspace. Move it to docs/STATUS.md (or another canonical living doc) and reference from CLAUDE.md if needed.`,
  action: `Move lines ${section.startLine}-${section.endLine} of ${section.fromFile} into docs/STATUS.md`,
  evidence: { workspace: ws, file: section.fromFile, heading: section.heading, lines: [section.startLine, section.endLine], tokens: section.estimatedTokens },
}
```

**Stale workspace CLAUDE.md** (only fires if `isStale && !isDrifting` — drifting is a stronger signal that subsumes stale):

```ts
{
  kind: 'context',
  severity: 'low',
  title: `${ws}: CLAUDE.md not edited in ${daysSinceModified} days`,
  body: `Workspace CLAUDE.md hasn't been touched in ${daysSinceModified} days. Could be fine if the workspace is dormant; review whether anything in it is now wrong or out of date.`,
  evidence: { workspace: ws, daysSinceModified, recentSessionCount },
}
```

**Drifting workspace CLAUDE.md** (`isDrifting`):

```ts
{
  kind: 'context',
  severity: 'medium',
  title: `${ws}: CLAUDE.md is ${daysSinceModified} days old; ${recentSessionCount} sessions since`,
  body: `You've had ${recentSessionCount} session(s) in this workspace since the last CLAUDE.md edit ${daysSinceModified} days ago. Doc has likely drifted from what you're actually doing — quick read-and-update pass recommended.`,
  evidence: { workspace: ws, daysSinceModified, recentSessionCount },
}
```

Severity ordering already handled by `severityOrder` in `recommendations.ts`; no changes needed there.

### 4. Dashboard — `src/dashboard/public/`

**`index.html`** — replace the `<table id="table-context">` block:

```html
<section class="card">
  <h2>CLAUDE.md health <span class="hint">per-workspace findings, sorted by issue count</span></h2>
  <div id="context-cards"></div>
</section>
```

**`app.js`** — `renderContextTable` → `renderContextCards`:

- Sort reports by total finding count desc (decaying + missing + bulky), then by total tokens desc
- For each report, render a card:
  - **Header**: workspace name · `~Nk tok` · `edited Nd ago` (or "edited today" / "never edited" / mtime unavailable) · status badge (`fresh` / `stale` / `drifting`)
  - **Findings list** (omit the `<ul>` entirely if empty):
    - Each `decayingSections` entry: `'Heading' lines A–B (~Ck tok)` + secondary line `→ move to docs/STATUS.md`
    - `missingImports` rolled up into one bullet: `N stale @-import(s): foo.md, bar.md` (truncate after 3 with "and N more")
    - `bulkyImports` rolled up: `N large @-import(s): docs/org-snapshot.md (~6.2k tok), …`
  - **Empty state**: cards with no findings collapse to a single muted line `✓ No issues`

**`styles.css`** — add:
- `.context-card` (margin-bottom, border, padding consistent with existing card styles)
- `.context-card-header` (flex row, workspace name + meta + badge)
- `.context-card .findings` (unordered list, tight line-height)
- `.context-card .finding-action` (smaller, muted color, indented under each finding)
- `.badge.fresh`, `.badge.stale`, `.badge.drifting` (color tokens; reuse existing severity palette where possible)

No backend changes needed — `/api/report` already returns `contextReports` in full; the new fields will flow through automatically once the inspector produces them.

### 5. Config / commands

`commands/context.ts` — also surface the new findings in the CLI output (decaying sections list, drift/stale flags). One-line-per-finding format consistent with the existing CLI rendering helpers in `commands/format.ts`.

No new CLI subcommand. No new config keys.

## Tests / verification

- Unit tests for `extractDecayingSections`:
  - Matches `## Recent Changes`, `### Next Steps`, `## Last updated: 2026-05-04`
  - Does NOT match `# Title` (H1 excluded)
  - Does NOT match `## Recently used libraries` (word-boundary check on the regex)
  - Section bounds correct when followed by same-level, deeper, or shallower heading
  - Section runs to EOF when no following heading
- Unit tests for staleness / drift:
  - `isStale` true when mtime > 60d ago, false otherwise
  - `isDrifting` requires both age >30d AND `recentSessionCount >= 5`
  - Both false when no files have mtime
- Manual verification on real data:
  - Run `ti context` and confirm decaying sections fire on the workspaces flagged by the audit (ROS, BJs, Sierra had these patterns before the May sweep — currently clean post-sweep, but the test fixture can include a synthetic CLAUDE.md with the patterns)
  - Run `ti` and confirm dashboard cards render correctly with findings

## Migration / backwards compat

Additive only:
- New optional fields on `ContextReport` — existing consumers (CLI, dashboard `app.js`) still work; updated to use the new fields
- No schema versioning needed for the cached `/api/report` response (10s TTL — first refresh after deploy reflects new fields)
- No changes to `~/.token-insight.json` config

## Implementation order

Suggested slicing for the implementation plan:

1. `extractDecayingSections` + unit tests
2. Wire `decayingSections` into `ContextReport`; update `inspectWorkspace`
3. Compute `daysSinceModified`, `recentSessionCount`, `isStale`, `isDrifting`; thread `sessions` through `inspectWorkspace`
4. New rec emitters in `contextRecs`; update existing rec copy where line-range refs add value
5. Dashboard: replace `renderContextTable` with `renderContextCards` + CSS
6. CLI: surface findings in `commands/context.ts`
7. End-to-end manual run on real `~/.claude/projects/` data; tune thresholds if needed
