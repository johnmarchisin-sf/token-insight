# Conductor Project Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rollupNameForPath` return the Conductor project name (e.g. `Sierra`, `token-insight`) instead of the sub-bucket name (`workspaces` / `production` / `sandbox`) for paths under `~/conductor/<sub-bucket>/<project>/...`.

**Architecture:** One new constant and one new branch at the top of `rollupNameForPath` in `src/core/workspace-mapper.ts`. All other paths fall through to the existing logic unchanged. No new files. No backend changes outside the mapper. The dashboard and CLI inherit the corrected labels because they all read `Session.workspaceName`, which is computed via `rollupNameForPath` at JSONL parse time.

**Tech Stack:** TypeScript, Node 18+. No test framework — verification is `npm run typecheck` plus running `ti workspaces` and the dashboard.

**Spec:** [`docs/superpowers/specs/2026-04-27-conductor-project-rollup-design.md`](../specs/2026-04-27-conductor-project-rollup-design.md)

---

### Task 1: Add Conductor sub-bucket branch to `rollupNameForPath`

**Files:**
- Modify: `src/core/workspace-mapper.ts` (currently 77 lines)

- [ ] **Step 1: Add the `CONDUCTOR_SUBBUCKETS` constant**

In `src/core/workspace-mapper.ts`, immediately AFTER the existing `KNOWN_BUCKETS` declaration (line 37: `const KNOWN_BUCKETS = ['conductor', 'projects', 'work', 'code', 'src'];`), append a new constant on its own line:

```typescript
const CONDUCTOR_SUBBUCKETS = ['workspaces', 'production', 'sandbox'];
```

- [ ] **Step 2: Add the new branch at the top of `rollupNameForPath`**

Locate the function `rollupNameForPath` (currently at lines 56–72). Inside the existing `if (workspacePath.startsWith(home + '/'))` block, insert a new branch BEFORE the existing `if (parts.length >= 2 && KNOWN_BUCKETS.includes(parts[0]))` check.

The current function body (for reference):

```typescript
export function rollupNameForPath(workspacePath: string): string {
  const home = homedir();
  if (workspacePath.startsWith(home + '/')) {
    const rel = workspacePath.slice(home.length + 1);
    const parts = rel.split('/').filter(Boolean);
    if (parts.length >= 2 && KNOWN_BUCKETS.includes(parts[0])) {
      return parts[1];
    }
  }
  // Fallback: try matching /conductor/ anywhere in the path.
  const segs = workspacePath.split('/').filter(Boolean);
  const idx = segs.indexOf('conductor');
  if (idx >= 0 && idx < segs.length - 1) {
    return segs[idx + 1];
  }
  return workspaceNameFromPath(workspacePath);
}
```

Replace the entire function with:

```typescript
export function rollupNameForPath(workspacePath: string): string {
  const home = homedir();
  if (workspacePath.startsWith(home + '/')) {
    const rel = workspacePath.slice(home.length + 1);
    const parts = rel.split('/').filter(Boolean);
    // Conductor convention: ~/conductor/<sub-bucket>/<project>/<workspace>/...
    // Use the project segment, not the sub-bucket.
    if (
      parts.length >= 3 &&
      parts[0] === 'conductor' &&
      CONDUCTOR_SUBBUCKETS.includes(parts[1])
    ) {
      return parts[2];
    }
    if (parts.length >= 2 && KNOWN_BUCKETS.includes(parts[0])) {
      return parts[1];
    }
  }
  // Fallback: try matching /conductor/ anywhere in the path.
  const segs = workspacePath.split('/').filter(Boolean);
  const idx = segs.indexOf('conductor');
  if (idx >= 0 && idx < segs.length - 1) {
    return segs[idx + 1];
  }
  return workspaceNameFromPath(workspacePath);
}
```

The new branch is the first check inside the home-relative block. It requires:
- At least 3 path segments below home (so there is a project segment to return).
- The first segment is exactly `conductor`.
- The second segment is one of the known sub-buckets.

If any of those fail, control falls through to the existing rules with no behavior change.

- [ ] **Step 3: Verify the file compiles**

Run: `npm run typecheck`
Expected: passes with no output (other than the npm script header).

- [ ] **Step 4: Manual sanity check via `node -e`**

Run this from the working directory `/Users/johnmarchisin/conductor/workspaces/token-insight/karachi`:

```bash
npx tsx -e "
  import { rollupNameForPath } from './src/core/workspace-mapper.ts';
  const cases = [
    ['/Users/johnmarchisin/conductor/workspaces/Sierra/surabaya/hubs', 'Sierra'],
    ['/Users/johnmarchisin/conductor/workspaces/token-insight/karachi', 'token-insight'],
    ['/Users/johnmarchisin/conductor/production/bjs/release-cut', 'bjs'],
    ['/Users/johnmarchisin/conductor/sandbox/poc/scratch', 'poc'],
    ['/Users/johnmarchisin/conductor/token-insight', 'token-insight'],
    ['/Users/johnmarchisin/projects/foo/bar', 'foo'],
  ];
  let pass = 0, fail = 0;
  for (const [input, expected] of cases) {
    const got = rollupNameForPath(input);
    const ok = got === expected;
    console.log((ok ? 'PASS' : 'FAIL'), input, '->', got, ok ? '' : '(expected ' + expected + ')');
    if (ok) pass++; else fail++;
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
"
```

Expected output: 6 PASS lines, then `6 passed, 0 failed`. The command exits 0 on success, non-zero on any failure.

If any case fails, re-read the function in `src/core/workspace-mapper.ts` and confirm the new branch is in the right place and uses `>=` (not `===`) for `parts.length >= 3`.

- [ ] **Step 5: Run `ti workspaces` to see the live impact**

Run: `npm run dev -- workspaces`

Expected: the printed table now shows the project names (e.g. `token-insight`, and any other Conductor project names you have JSONL history for) instead of `workspaces`/`production`/`sandbox` rows. If you have history under all three sub-buckets you should see that the bucket-named rows are gone.

This is informational only — it confirms the live behavior of the change. There's no automated check; just inspect the output.

- [ ] **Step 6: Commit**

```bash
git add src/core/workspace-mapper.ts
git commit -m "fix(workspace-mapper): roll up conductor sub-buckets to project name"
```

---

## Self-review notes

- **Spec coverage:** Section "Design" is fully implemented in Steps 1 and 2. The behavior matrix is exercised by Step 4's six test cases (one per row of the matrix). Risks/Out-of-scope sections are not implementation steps — they're informational and require no action.
- **Placeholders:** None. The full updated function body is shown verbatim.
- **Type/name consistency:** `CONDUCTOR_SUBBUCKETS` matches `KNOWN_BUCKETS` casing convention. The new branch uses the same `parts` variable already declared in the existing scope, and the same `home.length + 1` slice convention.
- **Out-of-scope guardrails:** No changes to `groupForWorkspace`, no other files touched, no new exports.
