# Skill catalog matching + per-session subagent recs (Slice C)

## Problem

Today's recommendations engine treats every recurring prompt cluster as a candidate for a *new* skill. That ignores two distinct realities:

1. **The user already has a skill that should be triggering on these prompts.** They might be typing the trigger phrase manually (skill description not specific enough to fire), or the skill is scoped narrowly (workspace-local) when it should be global. The cluster keeps growing because the skill isn't getting picked up.
2. **Long upfront exploration in a session benefits from a Task subagent**, but today's `subagentRecs` only flags this at workspace-rollup level (>= 60 turns, < 5 sidechain turns), not at session level where the user can act on a specific session.

## Goals

- For each prompt cluster that today qualifies as a skill candidate, check it against the user's installed skill catalog. If a match is found, emit a "use existing skill" rec that points at the skill path; if not, the existing "create new skill" rec runs as today.
- Add a per-session subagent rec for sessions with significant upfront Read/Glob/Grep activity and no `Task` use.
- Cast wide on thresholds — the user wants to see plenty of candidates and trim from there.
- Keep the existing workspace-rollup `subagentRecs` alongside the new per-session detector (different question, different answer).

## Non-goals

- Detect *whether* a skill actually fired during a session. That's a deeper signal that requires parsing tool-call sequences for skill invocations; out of scope.
- Auto-edit the user's skill descriptions. Recs are advisory only.
- Inline action surface for the new "use existing skill" rec beyond a path the user can open. (No new `<details>` panel like the SKILL.md scaffolder.)
- Workspace-level "missing CLAUDE.md" detector. Cut from this slice — the user explicitly redirected to prompt-level analysis.
- Broader hook category expansion. The existing `rereadRecs` already covers the main hook signal.

## Architecture

### Skill catalog discovery

New module `src/core/skill-catalog.ts` exports:

```ts
export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: 'plugin' | 'global' | 'workspace';
  /** Display label, e.g. "superpowers:brainstorming" or "user:session-wrap" or "ws:token-insight/foo" */
  label: string;
  skillPath: string;           // absolute path to the SKILL.md file
  descriptionTrigrams: string[];
}

export async function loadSkillCatalog(workspacePaths: string[]): Promise<SkillCatalogEntry[]>;
```

The catalog walks three roots, in order:

1. `~/.claude/plugins/cache/<owner>/<plugin>/<version>/skills/<skill>/SKILL.md` — plugin skills. Label: `<plugin>:<skill>`. Skip directories whose name starts with `temp_git_` (these are transient git-checkout caches and shouldn't be advertised as installed skills).
2. `~/.claude/skills/<skill>/SKILL.md` — user-global skills. Label: `user:<skill>`.
3. `<workspacePath>/.claude/skills/<skill>/SKILL.md` for each workspace path passed in. Label: `ws:<workspaceName>/<skill>`.

Each `SKILL.md` is read; the YAML frontmatter is parsed with a tiny purpose-built parser (the project deliberately avoids new dependencies). The parser:

- Recognizes the leading `---` line and the closing `---` line.
- Extracts `name: <value>` and `description: <value>` from key-value lines (handling unquoted, single-quoted, and double-quoted scalars on a single line).
- Treats anything multi-line or YAML-fancy as a description that ends at the closing `---`.
- Returns `{ name, description }`. Entries with empty `name` or `description` are skipped.

`descriptionTrigrams` is computed by reusing the existing `normalize()` and `trigramsOf()` helpers from `prompt-clusterer.ts`. The catalog is `Iterable<SkillCatalogEntry>` so the recommendations engine can run Jaccard against each entry.

Discovery uses `fs.readdir(..., { withFileTypes: true })` and skips symlinks (`dirent.isSymbolicLink()`). Recursion is bounded by the directory shape — there's no need to descend into `<plugin>/<version>/skills/<skill>/` more than that path's worth of levels.

The function is pure-IO; the caller decides when to run it (once per `getReport()` call on the dashboard, once per `ti recommend` invocation). No caching in this slice.

### Trigrams normalization for skill descriptions

To match a cluster against a description, both sides need the same normalization. We reuse `normalize()` and `trigramsOf()` from `prompt-clusterer.ts`, which means we promote those two helpers from file-private to module exports. The clusterer's behavior is unchanged (it still calls them locally).

### Cluster-vs-skill matching

In `src/core/recommendations.ts`, `skillRecs` is restructured. After the existing size/tokens guards and the denylist check, before constructing the rec body:

1. Compute `bestMatch = max-Jaccard skill catalog entry against the cluster's `trigrams`. If `bestMatch.similarity >= SKILL_MATCH_JACCARD` (default 0.2), the rec becomes a "match" rec; otherwise, the existing "create new skill" rec is emitted.

2. Match rec shape:
   - `kind: 'skill'`
   - `severity`: same scaling as today (`high` if totalTokens > 500k, `medium` if size >= 5, else `low`).
   - `title`: `Existing skill matches — <label> — make it more available`
   - `body`: text along the lines of:
     > "You've made N similar requests (X tokens). They look like they should be triggering your existing skill `<label>` (<source>), but the skill isn't firing. Two things help: tighten the skill's description so it picks up these phrases, or — if it's workspace-scoped — promote it to global. Skill file: <skillPath>"
   - `action`: `code <skillPath>` (CLI hint to open the file). The dashboard renders the path.
   - `evidence`:
     - all the existing fields (`clusterId`, `clusterIndex`, `size`, `totalTokens`, `workspaces`, `representative`, `examplePrompts`, `hidden`)
     - new: `matchedSkill: { label, name, source, skillPath, similarity }`

3. The Slice B denylist still filters first. A user who says "this cluster is a one-off" hides both the create-new-skill and the matches-existing variants for that fingerprint.

4. The Slice B inline scaffold panel only renders when `matchedSkill` is absent — there's no scaffold to show for a cluster that already has a skill. The dashboard UI checks `r.evidence.matchedSkill`; if present, it renders the skill path inline (read-only) instead of the 👍 / 👎 / scaffold-panel block. The 👎 button stays (so the user can still hide the rec).

### Per-session subagent rec

New private function `sessionSubagentRecs(sessions)` in `src/core/recommendations.ts`. Algorithm per session:

1. Walk turns in order, accumulating tool-call counts.
   - `exploreCount` = number of `Read` / `Glob` / `Grep` / `NotebookRead` tool calls strictly before the first `Edit` / `Write` / `MultiEdit` / `NotebookEdit` tool call. If no edit ever happens, it's the count over the whole session.
   - `usedSubagent` = any turn has `t.isSidechain === true`, OR any tool call has `name === 'Task'`.
2. If `exploreCount >= SUBAGENT_EXPLORE_MIN` (default 15) AND `!usedSubagent`, the session qualifies.
3. Sort qualifying sessions by `exploreCount` descending; cap to top 10.
4. Each rec:
   - `kind: 'subagent'`
   - `severity`: `high` if `exploreCount > 30`, else `medium`
   - `title`: `Exploration without subagent — <workspaceName>, <localized session start>`
   - `body`: explains the count, what `Task` does, and why it's lighter on the main context window.
   - `action`: none (the user can't run a single CLI command to retroactively fix the past session — the rec is educational).
   - `evidence`: `{ sessionId, workspace, exploreCount, hadEdit: boolean, sessionStartedAt }`.

The existing workspace-rollup `subagentRecs` stays unchanged. Both run; both emit recs.

### RecommendInputs

`src/core/recommendations.ts` adds one optional field:

```ts
export interface RecommendInputs {
  ...existing fields...
  skillCatalog?: SkillCatalogEntry[];
}
```

When omitted, `skillRecs` skips the matching step (defaults to today's behavior). Both the dashboard server and the CLI's `ti recommend` populate it.

### Tunable thresholds

Exported constants in `recommendations.ts`:

```ts
export const SKILL_MATCH_JACCARD = 0.2;
export const SUBAGENT_EXPLORE_MIN = 15;
```

Wide-net defaults. The user is expected to tune downward (raise) once they see real output.

## Files touched

**New**
- `src/core/skill-catalog.ts` — discovery, frontmatter parser, trigram precomputation.

**Modified**
- `src/core/prompt-clusterer.ts` — promote `normalize` and `trigramsOf` to exports (no behavior change).
- `src/core/recommendations.ts` — restructure `skillRecs` to consult the catalog; add `sessionSubagentRecs`; add tunable constants; thread `skillCatalog` through `RecommendInputs`.
- `src/dashboard/server.ts` — call `loadSkillCatalog` in the `Promise.all`; pass into `buildRecommendations`.
- `src/commands/recommend.ts` — same as the dashboard server.
- `src/dashboard/public/app.js` — when a skill rec has `evidence.matchedSkill`, render the matched-skill path/source inline (instead of the 👍/scaffold-panel block); keep 👎.
- `src/dashboard/public/styles.css` — minor: a `.matched-skill` block class for the new inline element.

## Verification

This project has no unit test framework. Verification:

1. `npm run typecheck` passes.
2. **Catalog discovery sanity**: `npx tsx -e "import { loadSkillCatalog } from './src/core/skill-catalog.ts'; (async () => { const c = await loadSkillCatalog([]); console.log('found:', c.length); console.log(c.slice(0, 3).map(e => e.label).join(', ')); })()"` should list a non-zero count and print labels including at least one `superpowers:*` and one `user:session-wrap`.
3. **Match detection sanity**: feed a fake cluster whose representative is `"wrap up the session"` and confirm it Jaccard-matches the `session-wrap` skill description above the threshold.
4. **End-to-end**: `ti recommend` should show some skill recs with the new `Existing skill matches — …` title (assuming the user has clusters that overlap with installed skill descriptions). Dashboard should render the matched-skill block for those recs.
5. **Per-session subagent**: `ti recommend --kind subagent` should list both the existing workspace-rollup recs AND the new per-session ones. The new ones name a specific session and explore count.
6. **Slice B integration**: clicking 👎 on a "matches existing skill" rec persists to the denylist and removes the card on reload. `ti undeny <id>` restores. Drift-tolerance via the existing trigram match still applies.

## Risks

- **Skill description matching is fuzzy.** A cluster about *"wrap up the session"* will match `session-wrap` cleanly, but a cluster about, say, *"explain this code"* might Jaccard-match a generic `code-reviewer` skill description even if they're semantically different. Threshold 0.2 is wide; expect some false positives. The denylist is the user's escape hatch.
- **Plugin cache contains transient `temp_git_*` directories** seen during plugin install. Skipping those by name is the simplest fix; if a real plugin's directory ever happens to start with `temp_git_`, it'll be silently filtered. Acceptable.
- **Skill descriptions vary in length.** A very short description (< 6 chars after normalization) won't have trigrams meaningful enough to match; the matcher should treat empty-trigram skills as un-matchable rather than crashing.
- **YAML frontmatter parsing is intentionally minimal.** It handles single-line scalar values for `name` and `description`. If a future skill uses multi-line strings, block scalars (`|`, `>`), or moves the description into the body, the parser silently fails for that skill. Acceptable for v1; we can grow the parser if it bites.

## Out of scope

- Detecting whether a skill actually invoked during a session.
- A dashboard table listing all installed skills.
- Auto-rewriting skill descriptions.
- Slice C originally proposed an out-of-context-workspace detector and broader hook expansion; both cut per user direction.
