# Conductor project-name workspace rollup

## Problem

`rollupNameForPath` in `src/core/workspace-mapper.ts` rolls every Conductor workspace up to a Conductor sub-bucket name (`workspaces` / `production` / `sandbox`) instead of the actual project name (e.g. `Sierra`, `token-insight`, `bjs`). Result: every per-workspace view in the dashboard, every cluster's "workspaces:" tag, and every recommendation's evidence shows the same handful of bucket names — making it impossible to tell which actual project is consuming tokens.

The rollup function was written for a flatter convention (`~/<bucket>/<project>/...`) where `<project>` lives at index 1. Conductor instead uses `~/conductor/<sub-bucket>/<project>/<workspace>/...` — one level deeper.

Concrete examples:
- `~/conductor/workspaces/Sierra/surabaya/hubs` → today returns `workspaces`; should return `Sierra`.
- `~/conductor/workspaces/token-insight/karachi` → today returns `workspaces`; should return `token-insight`.

## Goals

- Correctly extract the project segment for paths under `~/conductor/<sub-bucket>/<project>/...`.
- Leave non-Conductor paths and direct top-level Conductor projects (`~/conductor/<project>`) unchanged.
- No new dependencies. No new config files. No new CLI surface.

## Non-goals

- Display aliases that fold related projects under one label (e.g. `snb-hubs`/`snb-npd` → `SNB`). Keep granularity at the project segment for now; collapse later if it becomes annoying.
- A user-editable config (`~/.token-insight.json`) for label overrides.
- Any UI/UX changes — the dashboard automatically picks up the corrected labels because they flow through `Session.workspaceName`.
- Changes to `groupForWorkspace` (the bucket function). It still returns `conductor` for these paths, which is correct.

## Design

Add a small constant naming the Conductor sub-buckets, and add one branch to `rollupNameForPath` that handles them.

```ts
// New constant alongside KNOWN_BUCKETS in src/core/workspace-mapper.ts:
const CONDUCTOR_SUBBUCKETS = ['workspaces', 'production', 'sandbox'];
```

`rollupNameForPath` logic, expressed in order:

1. If the path is `~/conductor/<sub>/<project>/...` where `<sub>` is in `CONDUCTOR_SUBBUCKETS` — return `<project>` (segment index 2, 0-indexed from `parts`).
2. Otherwise, fall through to the existing rule: if the path starts with `~/<bucket>/...` where `<bucket>` is in `KNOWN_BUCKETS`, return `<project>` (segment index 1). This still correctly handles `~/conductor/<project>` directly.
3. Otherwise, fall through to the legacy "find `/conductor/` anywhere in the path" rule (already in the function).
4. Otherwise, fall back to the workspace's own short name.

The new rule is checked first because it is the most specific. The other branches are unchanged.

### Behavior matrix

| Path                                                  | Before        | After          |
|-------------------------------------------------------|---------------|----------------|
| `~/conductor/workspaces/Sierra/surabaya/hubs`         | `workspaces`  | `Sierra`       |
| `~/conductor/workspaces/token-insight/karachi`        | `workspaces`  | `token-insight`|
| `~/conductor/production/bjs/release-cut`              | `production`  | `bjs`          |
| `~/conductor/sandbox/poc/scratch`                     | `sandbox`     | `poc`          |
| `~/conductor/token-insight`                           | `token-insight` | `token-insight` (unchanged) |
| `~/conductor/notes` (no second segment)               | `notes`       | `notes` (unchanged) |
| `~/projects/foo/bar`                                  | `foo`         | `foo` (unchanged)   |
| `~/work/some-repo`                                    | `some-repo`   | `some-repo` (unchanged) |

### Edge case

If a future user genuinely names a Conductor *project* `workspaces` / `production` / `sandbox` (so the path is `~/conductor/workspaces`), `parts.length` is 2 and the new branch's `parts.length >= 4` guard fails. They fall through to the existing rule which returns `parts[1]` = `workspaces`. The behavior is the same as today — not great, but no regression and unlikely.

## Files touched

- `src/core/workspace-mapper.ts` — add the constant, add the new branch at the top of `rollupNameForPath`.

## Verification

This project has no unit test framework. Verification:

1. `npm run typecheck` — passes.
2. From the karachi workspace itself (`/Users/johnmarchisin/conductor/workspaces/token-insight/karachi`), run `ti workspaces`. Confirm the row that previously appeared as `workspaces` now appears as `token-insight` (and other Conductor projects show their real names).
3. From a non-Conductor path (or by inspecting an unrelated workspace if available), confirm those rows are unchanged.
4. Open the dashboard via `ti` and confirm the "By workspace" chart and table use the project names. The cluster panel's `workspaces:` tag pills show project names as well.

## Risks

- **Caching:** the dashboard caches `/api/report` for 10 seconds and reads sessions from the JSONL store on each cache miss. Because `Session.workspaceName` is computed at parse time, a running dashboard server holds stale labels in cache for ≤10 s after a code change. Restart the server (`ti`) after deploying.
- **The `byWorkspaceGroup` aggregator** keys off `Session.workspaceGroup` (from `groupForWorkspace`, unchanged), so group rollups still resolve to `conductor`. That is intentional: per-project granularity is the *workspace* axis; the *group* axis is still the bucket. No spillover.

## Out of scope

- Aliases / display labels (Slice A leftover that the user explicitly deferred).
- Adding `~/.token-insight.json` config support.
- CLI commands to manage workspace labels.
- Slices B and C of the broader feedback (recommendation UX, phase-2 optimization signals). Those are tracked separately.
