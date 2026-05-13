# Actionable CLAUDE.md Context Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's CLAUDE.md reporting concrete and actionable by detecting decaying-state sections, staleness, and drift — replacing the bare bloat table with per-workspace findings cards.

**Architecture:** Additive changes to `src/core/context-inspector.ts` (new types, regex-based heading scan, mtime+drift fields), three new emitters in `src/core/recommendations.ts`, and a dashboard rewrite of the bloat table into findings cards. No new dependencies; tests via Node's built-in `node:test` runner driven by `tsx`.

**Tech Stack:** TypeScript (strict, ESM), Node 18+, vanilla JS dashboard, `tsx` for dev/test, no test framework.

**Spec:** `docs/superpowers/specs/2026-05-06-actionable-context-recs-design.md`

---

## File Structure

**Modify:**
- `src/core/context-inspector.ts` — add `DecayingSection` type, new `ContextReport` fields, regex constants, `extractDecayingSections()`, mtime/drift computation, threading sessions through `inspectWorkspace`
- `src/core/recommendations.ts` — `contextRecs()` gains three new emitters (decaying section, stale, drifting)
- `src/commands/context.ts` — surface new findings in CLI output
- `src/dashboard/public/index.html` — replace `<table id="table-context">` with `<div id="context-cards">`
- `src/dashboard/public/app.js` — replace `renderContextTable()` with `renderContextCards()`
- `src/dashboard/public/styles.css` — add `.context-card`, `.findings`, `.badge` styles
- `package.json` — add `test` script

**Create:**
- `src/core/context-inspector.test.ts` — Node `node:test` unit tests for the pure-function bits

---

## Task 1: Add types, constants, and `extractDecayingSections` (with tests)

**Files:**
- Modify: `src/core/context-inspector.ts`
- Create: `src/core/context-inspector.test.ts`
- Modify: `package.json:11` (add test script)

- [ ] **Step 1: Add the test script to `package.json`**

In `package.json`, inside `"scripts"`, add the `test` line. Final scripts block:

```json
"scripts": {
  "build": "tsc && node -e \"require('fs').cpSync('src/dashboard/public','dist/dashboard/public',{recursive:true})\"",
  "dev": "tsx src/cli.ts",
  "dev:dashboard": "tsx src/cli.ts dashboard",
  "start": "node dist/cli.js",
  "typecheck": "tsc --noEmit",
  "test": "tsx --test src/core/*.test.ts",
  "clean": "rm -rf dist"
}
```

- [ ] **Step 2: Write the failing tests for `extractDecayingSections`**

Create `src/core/context-inspector.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDecayingSections } from './context-inspector.js';

const FILE = '/tmp/CLAUDE.md';

test('matches H2 "Recent Changes" heading', () => {
  const md = [
    '# Project',
    '',
    '## Recent Changes',
    '- did a thing',
    '- did another',
    '',
    '## Setup',
    'unrelated',
  ].join('\n');
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, 'Recent Changes');
  assert.equal(sections[0].startLine, 3);
  assert.equal(sections[0].endLine, 6);
  assert.equal(sections[0].lineCount, 4);
});

test('matches multiple decaying headings of varied levels', () => {
  const md = [
    '# Title',
    '## Next Steps',
    'a',
    '### Future Work',
    'b',
    '## Setup',
    'c',
    '## Known Issues',
    'd',
  ].join('\n');
  const sections = extractDecayingSections(md, FILE);
  const headings = sections.map((s) => s.heading);
  assert.deepEqual(headings.sort(), ['Future Work', 'Known Issues', 'Next Steps']);
});

test('excludes H1 even when text matches', () => {
  const md = '# Recent Changes\nbody';
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 0);
});

test('does not match headings whose decay-word is not at the start', () => {
  const md = '## My Recent Changes\nbody\n## Recently Used\nbody';
  const sections = extractDecayingSections(md, FILE);
  // "My Recent Changes" — no match (decay word not at start)
  // "Recently Used" — `recent\s+\w+` requires the form "recent <word>"
  //   so "Recently" alone does not match. Both filtered out.
  assert.equal(sections.length, 0);
});

test('section runs to EOF when no following heading', () => {
  const md = '# Title\n## TODO\n- a\n- b\n- c';
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].endLine, 5);
  assert.equal(sections[0].lineCount, 4);
});

test('section bounded by same-or-higher level heading, not deeper', () => {
  const md = [
    '# Title',
    '## Next Steps',          // line 2
    'body of next steps',     // line 3
    '### Sub of Next Steps',  // line 4 — deeper, should NOT close section
    'still inside',           // line 5
    '## Other',               // line 6 — same level, closes
  ].join('\n');
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].startLine, 2);
  assert.equal(sections[0].endLine, 5);
});

test('estimatedTokens scales with byte count', () => {
  const longBody = 'word '.repeat(200); // ~1000 bytes
  const md = `# Title\n## Status\n${longBody}`;
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.ok(sections[0].estimatedTokens > 200, 'expected >200 tok for ~1k-byte section');
});

test('returns empty for content with no matching headings', () => {
  const md = '# Title\n## Setup\nfoo\n## Architecture\nbar';
  assert.deepEqual(extractDecayingSections(md, FILE), []);
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test`
Expected: FAIL — `extractDecayingSections` is not exported / not a function. Errors about missing export are fine; the goal is "tests run, function doesn't exist yet."

- [ ] **Step 4: Add new types and constants to `context-inspector.ts`**

In `src/core/context-inspector.ts`, near the top, after the existing `import` block and before `CONTEXT_NAMES`:

```ts
const STALE_DAYS = 60;
const DRIFT_DAYS = 30;
const DRIFT_SESSIONS = 5;

const DECAYING_HEADING_PATTERNS: RegExp[] = [
  /^#{2,}\s+(recent\s+\w+|current\s+\w+|next\s+steps?|in\s+progress|todo|last\s+updated|status|activity|recent\s+activity|known\s+issues|quick\s+wins|future\s+work)\b/i,
];
```

Add this exported interface after `BulkyImport`:

```ts
export interface DecayingSection {
  fromFile: string;
  heading: string;
  startLine: number;        // 1-indexed line of the heading
  endLine: number;          // 1-indexed last line of the section
  lineCount: number;
  estimatedTokens: number;
}
```

Extend the existing `ContextReport` with the new optional fields. Replace the existing interface block with:

```ts
export interface ContextReport {
  workspacePath: string;
  workspaceName: string;
  files: ContextFile[];
  totalEstimatedTokens: number;
  missingImports: MissingImport[];
  bulkyImports: BulkyImport[];
  decayingSections: DecayingSection[];
  daysSinceModified?: number;
  recentSessionCount: number;
  isStale: boolean;
  isDrifting: boolean;
}
```

- [ ] **Step 5: Implement `extractDecayingSections`**

Append to the bottom of `src/core/context-inspector.ts`:

```ts
/**
 * Find sections in a markdown body whose heading suggests decaying state
 * (e.g. "Recent Changes", "Next Steps", "TODO"). Returns one entry per
 * matching heading. H1 is excluded — it's the file title.
 */
export function extractDecayingSections(content: string, fromFile: string): DecayingSection[] {
  const lines = content.split('\n');
  const headings: { lineIdx: number; level: number; text: string; matched: boolean }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+(.*\S)\s*$/);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2];
    if (level < 2) continue; // skip H1 entirely
    const matched = DECAYING_HEADING_PATTERNS.some((p) => p.test(lines[i]));
    headings.push({ lineIdx: i, level, text, matched });
  }

  const out: DecayingSection[] = [];
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h];
    if (!cur.matched) continue;
    // Section ends at the next heading of same-or-higher level (lower number),
    // or EOF.
    let endIdx = lines.length - 1;
    for (let k = h + 1; k < headings.length; k++) {
      if (headings[k].level <= cur.level) {
        endIdx = headings[k].lineIdx - 1;
        break;
      }
    }
    const startLine = cur.lineIdx + 1;
    const endLine = endIdx + 1;
    const slice = lines.slice(cur.lineIdx, endIdx + 1).join('\n');
    const bytes = Buffer.byteLength(slice, 'utf8');
    out.push({
      fromFile,
      heading: cur.text,
      startLine,
      endLine,
      lineCount: endLine - startLine + 1,
      estimatedTokens: Math.round(bytes * TOKEN_PER_BYTE_ESTIMATE),
    });
  }
  return out;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: All 8 tests in `context-inspector.test.ts` pass.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: No errors. (`recentSessionCount`, `isStale`, `isDrifting` will not yet be set anywhere — that's fixed in Task 2; for now the interface change should still compile because TypeScript's structural types only flag at construction sites. Existing `inspectWorkspace` constructs `ContextReport` literals, so the typecheck WILL fail here. That's expected — fix continues in next step.)

- [ ] **Step 8: Backfill missing fields in `inspectWorkspace` so typecheck passes**

In `src/core/context-inspector.ts`, find the existing `return { workspacePath, workspaceName, files, totalEstimatedTokens, missingImports, bulkyImports }` near the end of `inspectWorkspace`. Replace it with:

```ts
  return {
    workspacePath,
    workspaceName,
    files,
    totalEstimatedTokens,
    missingImports,
    bulkyImports,
    decayingSections: [],
    daysSinceModified: undefined,
    recentSessionCount: 0,
    isStale: false,
    isDrifting: false,
  };
```

(These get filled in properly in Task 2 — this commit just keeps the typecheck green.)

- [ ] **Step 9: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: Both pass.

- [ ] **Step 10: Commit**

```bash
git add src/core/context-inspector.ts src/core/context-inspector.test.ts package.json
git commit -m "feat(context): decaying-section detector + types + tests

Adds extractDecayingSections() with regex-based heading scan for sections
that read like decaying state (Recent Changes, Next Steps, TODO, Status,
Known Issues, Future Work, etc). Adds DecayingSection type and extends
ContextReport with decayingSections / staleness / drift fields.

Tests via node:test through tsx --test (zero new deps)."
```

---

## Task 2: Wire decaying sections + mtime/drift into `inspectWorkspace`

**Files:**
- Modify: `src/core/context-inspector.ts`
- Modify: `src/core/context-inspector.test.ts`

- [ ] **Step 1: Add a test for the drift/stale boolean logic**

Append to `src/core/context-inspector.test.ts`:

```ts
import { computeStaleness } from './context-inspector.js';

test('computeStaleness: drifting when old + active', () => {
  const r = computeStaleness({
    daysSinceModified: 45,
    recentSessionCount: 7,
  });
  assert.equal(r.isStale, false, 'drifting takes precedence over stale');
  assert.equal(r.isDrifting, true);
});

test('computeStaleness: stale when very old, regardless of activity', () => {
  const r = computeStaleness({
    daysSinceModified: 90,
    recentSessionCount: 0,
  });
  assert.equal(r.isStale, true);
  assert.equal(r.isDrifting, false);
});

test('computeStaleness: drifting beats stale at 90 days + active', () => {
  const r = computeStaleness({
    daysSinceModified: 90,
    recentSessionCount: 12,
  });
  assert.equal(r.isStale, false);
  assert.equal(r.isDrifting, true);
});

test('computeStaleness: neither when fresh', () => {
  const r = computeStaleness({ daysSinceModified: 5, recentSessionCount: 20 });
  assert.equal(r.isStale, false);
  assert.equal(r.isDrifting, false);
});

test('computeStaleness: neither when daysSinceModified undefined', () => {
  const r = computeStaleness({ daysSinceModified: undefined, recentSessionCount: 20 });
  assert.equal(r.isStale, false);
  assert.equal(r.isDrifting, false);
});

test('computeStaleness: not drifting when old but few sessions', () => {
  const r = computeStaleness({ daysSinceModified: 35, recentSessionCount: 2 });
  assert.equal(r.isDrifting, false);
  assert.equal(r.isStale, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: 6 new tests fail with `computeStaleness is not exported`.

- [ ] **Step 3: Add `computeStaleness` to `context-inspector.ts`**

Append to `src/core/context-inspector.ts`:

```ts
export function computeStaleness(input: {
  daysSinceModified: number | undefined;
  recentSessionCount: number;
}): { isStale: boolean; isDrifting: boolean } {
  const { daysSinceModified, recentSessionCount } = input;
  if (daysSinceModified === undefined) return { isStale: false, isDrifting: false };
  const isDrifting = daysSinceModified > DRIFT_DAYS && recentSessionCount >= DRIFT_SESSIONS;
  // Drifting subsumes stale — don't double-count.
  const isStale = !isDrifting && daysSinceModified > STALE_DAYS;
  return { isStale, isDrifting };
}
```

- [ ] **Step 4: Update `inspectWorkspace` signature to take sessions**

In `src/core/context-inspector.ts`, replace the `inspectWorkspace` declaration line:

```ts
export async function inspectWorkspace(workspacePath: string, workspaceName: string): Promise<ContextReport | null> {
```

with:

```ts
export async function inspectWorkspace(
  workspacePath: string,
  workspaceName: string,
  workspaceSessions: Session[] = [],
): Promise<ContextReport | null> {
```

- [ ] **Step 5: Compute decaying sections inside `inspectWorkspace`**

Inside the `for (const name of CONTEXT_NAMES)` loop, after the `if (f.exists)` branch's existing logic that pushes `files` and processes references, add a parallel call. Replace the entire body of the existing `if (f.exists) { ... }` block with:

```ts
    if (f.exists) {
      files.push(f);
      const content = await safeRead(fp);
      decayingSections.push(...extractDecayingSections(content, fp));
      const refs = extractFileReferences(content);
      for (const ref of refs) {
        const resolved = resolveReference(workspacePath, ref);
        if (!resolved) {
          missingImports.push({ fromFile: fp, reference: ref });
          continue;
        }
        const f2 = await statContextFile(resolved);
        if (!f2.exists) {
          missingImports.push({ fromFile: fp, reference: ref, resolvedPath: resolved });
        } else if (f2.estimatedTokens >= 4_000) {
          bulkyImports.push({
            fromFile: fp,
            reference: ref,
            resolvedPath: resolved,
            bytes: f2.bytes,
            lines: f2.lines,
            estimatedTokens: f2.estimatedTokens,
          });
        }
      }
    }
```

(The only addition is the `decayingSections.push(...)` line; everything else is unchanged.)

At the top of the function body, add `const decayingSections: DecayingSection[] = [];` next to the existing `missingImports` / `bulkyImports` declarations:

```ts
  const files: ContextFile[] = [];
  const missingImports: MissingImport[] = [];
  const bulkyImports: BulkyImport[] = [];
  const decayingSections: DecayingSection[] = [];
```

- [ ] **Step 6: Compute mtime, drift, and recentSessionCount in `inspectWorkspace`**

In `src/core/context-inspector.ts`, replace the final `return { ... }` block in `inspectWorkspace` with:

```ts
  if (files.length === 0 && missingImports.length === 0) return null;

  const totalEstimatedTokens = files.reduce((s, f) => s + f.estimatedTokens, 0);

  // Newest mtime across CLAUDE.md and CLAUDE.local.md.
  const mtimes = files
    .map((f) => f.lastModified)
    .filter((d): d is Date => d instanceof Date);
  const newestMtime = mtimes.length > 0
    ? new Date(Math.max(...mtimes.map((d) => d.getTime())))
    : undefined;
  const daysSinceModified = newestMtime
    ? Math.floor((Date.now() - newestMtime.getTime()) / 86_400_000)
    : undefined;
  const recentSessionCount = newestMtime
    ? workspaceSessions.filter((s) => s.endedAt > newestMtime).length
    : 0;
  const { isStale, isDrifting } = computeStaleness({ daysSinceModified, recentSessionCount });

  return {
    workspacePath,
    workspaceName,
    files,
    totalEstimatedTokens,
    missingImports,
    bulkyImports,
    decayingSections,
    daysSinceModified,
    recentSessionCount,
    isStale,
    isDrifting,
  };
```

- [ ] **Step 7: Update `inspectAllWorkspaces` to pass per-workspace sessions**

Replace the existing `inspectAllWorkspaces` body with:

```ts
export async function inspectAllWorkspaces(sessions: Session[]): Promise<ContextReport[]> {
  const seen = new Map<string, string>(); // path -> name
  for (const s of sessions) seen.set(s.workspacePath, s.workspaceName);

  // Group sessions by workspacePath so we can pass each workspace's sessions in.
  const byPath = new Map<string, Session[]>();
  for (const s of sessions) {
    const arr = byPath.get(s.workspacePath) ?? [];
    arr.push(s);
    byPath.set(s.workspacePath, arr);
  }

  const out: ContextReport[] = [];
  for (const [p, n] of seen) {
    const r = await inspectWorkspace(p, n, byPath.get(p) ?? []);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.totalEstimatedTokens - a.totalEstimatedTokens);
}
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: All tests pass, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/core/context-inspector.ts src/core/context-inspector.test.ts
git commit -m "feat(context): compute mtime drift and wire decaying sections into ContextReport

inspectWorkspace now scans for decaying sections, computes daysSinceModified
from the newest CLAUDE.md mtime, counts sessions since that mtime, and sets
isStale / isDrifting (drifting subsumes stale). inspectAllWorkspaces groups
sessions by workspacePath and threads them through."
```

---

## Task 3: New recommendation emitters in `recommendations.ts`

**Files:**
- Modify: `src/core/recommendations.ts:217-283` (the `contextRecs` function)

- [ ] **Step 1: Read the existing `contextRecs` to confirm shape**

Read `src/core/recommendations.ts` lines 217-283. Confirm the signature is `function contextRecs(reports: ContextReport[], global: GlobalContextReport): Recommendation[]` and that it currently emits global bloat, workspace bloat, missing imports, and bulky imports.

- [ ] **Step 2: Add new emitters at the end of the per-report loop**

Inside `contextRecs`, find the closing `}` of the `for (const r of reports) { ... }` loop. Just before the closing `}` of that for-loop (after the `// Bulky @-imports.` block), insert:

```ts
    // Decaying-state sections — concrete "move this to STATUS.md" recs.
    for (const sec of r.decayingSections) {
      out.push({
        kind: 'context',
        severity: sec.lineCount > 40 ? 'medium' : 'low',
        title:
          `${r.workspaceName}: '${sec.heading}' section in CLAUDE.md ` +
          `(lines ${sec.startLine}-${sec.endLine}, ~${formatTokens(sec.estimatedTokens)} tok)`,
        body:
          `This section reads like decaying state — content that goes stale between edits and ` +
          `pays a token tax on every prompt in this workspace. Move it to docs/STATUS.md ` +
          `(or another canonical living doc) and reference from CLAUDE.md if needed.`,
        action: `Move lines ${sec.startLine}-${sec.endLine} of ${sec.fromFile} into docs/STATUS.md`,
        evidence: {
          workspace: r.workspaceName,
          file: sec.fromFile,
          heading: sec.heading,
          lines: [sec.startLine, sec.endLine],
          tokens: sec.estimatedTokens,
        },
      });
    }

    // Drifting CLAUDE.md — old AND active workspace.
    if (r.isDrifting && r.daysSinceModified !== undefined) {
      out.push({
        kind: 'context',
        severity: 'medium',
        title:
          `${r.workspaceName}: CLAUDE.md is ${r.daysSinceModified} days old; ` +
          `${r.recentSessionCount} sessions since`,
        body:
          `You've had ${r.recentSessionCount} session(s) in this workspace since the last ` +
          `CLAUDE.md edit ${r.daysSinceModified} days ago. Doc has likely drifted from what ` +
          `you're actually doing — quick read-and-update pass recommended.`,
        evidence: {
          workspace: r.workspaceName,
          daysSinceModified: r.daysSinceModified,
          recentSessionCount: r.recentSessionCount,
        },
      });
    }

    // Stale CLAUDE.md — old, but no recent activity (drift takes precedence).
    if (r.isStale && r.daysSinceModified !== undefined) {
      out.push({
        kind: 'context',
        severity: 'low',
        title: `${r.workspaceName}: CLAUDE.md not edited in ${r.daysSinceModified} days`,
        body:
          `Workspace CLAUDE.md hasn't been touched in ${r.daysSinceModified} days. Could be ` +
          `fine if the workspace is dormant; review whether anything in it is now wrong or ` +
          `out of date.`,
        evidence: {
          workspace: r.workspaceName,
          daysSinceModified: r.daysSinceModified,
          recentSessionCount: r.recentSessionCount,
        },
      });
    }
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All existing tests still pass.

- [ ] **Step 5: Smoke-test against real data**

Run: `npm run dev -- recommend`
Expected: Output includes recommendations. If your workspaces have decaying sections (e.g. token-insight/karachi has `## Known issues / quick wins` and `## Future work parked`), you should see new recs like:
```
[medium] token-insight: 'Known issues / quick wins' section in CLAUDE.md (lines 47-52, ~XXX tok)
```

- [ ] **Step 6: Commit**

```bash
git add src/core/recommendations.ts
git commit -m "feat(recommendations): emit specific decaying-section + drift + stale recs

contextRecs now emits one rec per decaying section (with line range + token
cost + concrete action), one rec per drifting CLAUDE.md (old + recent
activity), and one rec per stale CLAUDE.md (drift subsumes stale).

Replaces the previously generic 'trim CLAUDE.md' guidance with findings
that name the offending section by heading and line range."
```

---

## Task 4: Surface findings in CLI `commands/context.ts`

**Files:**
- Modify: `src/commands/context.ts`

- [ ] **Step 1: Update the workspace table to include drift indicator**

In `src/commands/context.ts`, replace the `console.log(table(...))` block (lines 38-49) with:

```ts
  console.log(
    table(
      reports.map((r) => ({
        workspace: r.workspaceName,
        lines: String(r.files.reduce((s, f) => s + f.lines, 0)),
        tokens: fmtTokens(r.totalEstimatedTokens),
        age: r.daysSinceModified === undefined ? '?' : `${r.daysSinceModified}d`,
        state: r.isDrifting ? 'drifting' : r.isStale ? 'stale' : 'fresh',
        decay: String(r.decayingSections.length),
        missing: String(r.missingImports.length),
        bulky: String(r.bulkyImports.length),
      })),
      ['workspace', 'lines', 'tokens', 'age', 'state', 'decay', 'missing', 'bulky']
    )
  );
```

- [ ] **Step 2: Update the per-workspace findings block to include decaying sections**

In `src/commands/context.ts`, replace the entire `for (const r of reports) { ... }` block at lines 51-67 with:

```ts
  for (const r of reports) {
    const hasFindings =
      r.decayingSections.length > 0 ||
      r.missingImports.length > 0 ||
      r.bulkyImports.length > 0 ||
      r.isStale ||
      r.isDrifting;
    if (!hasFindings) continue;
    console.log();
    console.log(bold(`Findings in ${r.workspaceName}`));
    if (r.isDrifting && r.daysSinceModified !== undefined) {
      console.log(
        warn(`  ⚠ Drifting:`) +
          ` ${r.daysSinceModified} days since last edit, ${r.recentSessionCount} sessions since`
      );
    } else if (r.isStale && r.daysSinceModified !== undefined) {
      console.log(dim(`  • Stale: ${r.daysSinceModified} days since last edit`));
    }
    if (r.decayingSections.length > 0) {
      console.log(dim('  Decaying-state sections (move to docs/STATUS.md):'));
      for (const sec of r.decayingSections) {
        console.log(
          `    • '${sec.heading}'  lines ${sec.startLine}-${sec.endLine}  ` +
            `~${fmtTokens(sec.estimatedTokens)} tokens`
        );
      }
    }
    if (r.missingImports.length > 0) {
      console.log(dim('  Missing references:'));
      for (const m of r.missingImports) {
        console.log(`    • ${m.reference}` + (m.resolvedPath ? dim(` -> ${m.resolvedPath}`) : ''));
      }
    }
    if (r.bulkyImports.length > 0) {
      console.log(dim('  Bulky imports (>4k tokens):'));
      for (const b of r.bulkyImports) {
        console.log(`    • ${b.reference}  ${b.lines} lines  ~${fmtTokens(b.estimatedTokens)} tokens`);
      }
    }
  }
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Smoke-test**

Run: `npm run dev -- context`
Expected: Workspace table now has columns for `age`, `state`, and `decay`. Per-workspace findings include any decaying sections by heading and line range, plus a drift/stale line if applicable.

- [ ] **Step 5: Commit**

```bash
git add src/commands/context.ts
git commit -m "feat(cli): surface decaying sections + drift/stale state in ti context"
```

---

## Task 5: Replace bloat table with findings cards on the dashboard

**Files:**
- Modify: `src/dashboard/public/index.html:115-117`
- Modify: `src/dashboard/public/app.js:65, 258-279`
- Modify: `src/dashboard/public/styles.css` (append to file)

- [ ] **Step 1: Replace the table markup with a cards container**

In `src/dashboard/public/index.html`, find the block at lines 115-117:

```html
<section class="card">
  <h2>CLAUDE.md bloat <span class="hint">workspaces with the heaviest context overhead</span></h2>
  <table id="table-context" class="data-table"></table>
</section>
```

Replace it with:

```html
<section class="card">
  <h2>CLAUDE.md health <span class="hint">per-workspace findings, sorted by issue count</span></h2>
  <div id="context-cards"></div>
</section>
```

- [ ] **Step 2: Update `app.js` call site**

In `src/dashboard/public/app.js`, find line 65:

```js
  renderContextTable(d.contextReports || []);
```

Replace with:

```js
  renderContextCards(d.contextReports || []);
```

- [ ] **Step 3: Replace `renderContextTable` with `renderContextCards`**

In `src/dashboard/public/app.js`, replace the entire `renderContextTable` function (lines 258-280) with:

```js
function renderContextCards(reports) {
  const container = $('context-cards');
  if (!reports.length) {
    container.innerHTML =
      '<p style="color:var(--text-dim);margin:0">No CLAUDE.md files found in your workspaces yet.</p>';
    return;
  }

  // Sort: most findings first, then biggest tokens.
  const findingCount = (r) =>
    (r.decayingSections?.length || 0) +
    (r.missingImports?.length || 0) +
    (r.bulkyImports?.length || 0) +
    (r.isDrifting ? 1 : 0) +
    (r.isStale ? 1 : 0);
  const sorted = [...reports].sort((a, b) => {
    const fc = findingCount(b) - findingCount(a);
    if (fc !== 0) return fc;
    return (b.totalEstimatedTokens || 0) - (a.totalEstimatedTokens || 0);
  });

  container.innerHTML = sorted.map(contextCardHtml).join('');
}

function contextCardHtml(r) {
  const lines = (r.files || []).reduce((s, f) => s + (f.lines || 0), 0);
  const ageLabel =
    r.daysSinceModified === undefined || r.daysSinceModified === null
      ? 'mtime unknown'
      : r.daysSinceModified === 0
      ? 'edited today'
      : `edited ${r.daysSinceModified}d ago`;
  const badge = r.isDrifting
    ? '<span class="badge drifting">drifting</span>'
    : r.isStale
    ? '<span class="badge stale">stale</span>'
    : '<span class="badge fresh">fresh</span>';
  const meta = [
    `${lines} lines`,
    `~${fmtTokens(r.totalEstimatedTokens || 0)} tok`,
    ageLabel,
  ].join(' · ');

  const findings = [];

  if (r.isDrifting && r.daysSinceModified != null) {
    findings.push(
      `<li><strong>Drifting</strong> — ${r.recentSessionCount} session(s) in this workspace since the last edit ${r.daysSinceModified}d ago` +
        `<div class="finding-action">→ quick read-and-update pass recommended</div></li>`
    );
  } else if (r.isStale && r.daysSinceModified != null) {
    findings.push(
      `<li><strong>Stale</strong> — not edited in ${r.daysSinceModified} days` +
        `<div class="finding-action">→ review for outdated content if the workspace is still active</div></li>`
    );
  }

  for (const sec of r.decayingSections || []) {
    findings.push(
      `<li>'<strong>${escapeHtml(sec.heading)}</strong>' lines ${sec.startLine}–${sec.endLine} ` +
        `(~${fmtTokens(sec.estimatedTokens)} tok)` +
        `<div class="finding-action">→ move to docs/STATUS.md</div></li>`
    );
  }

  if ((r.missingImports || []).length > 0) {
    const sample = r.missingImports
      .slice(0, 3)
      .map((m) => escapeHtml(m.reference))
      .join(', ');
    const more =
      r.missingImports.length > 3 ? ` <span class="hint">and ${r.missingImports.length - 3} more</span>` : '';
    findings.push(
      `<li><strong>${r.missingImports.length} stale @-import(s)</strong>: ${sample}${more}` +
        `<div class="finding-action">→ remove or fix the references</div></li>`
    );
  }

  if ((r.bulkyImports || []).length > 0) {
    const sample = r.bulkyImports
      .slice(0, 3)
      .map((b) => `${escapeHtml(b.reference)} (~${fmtTokens(b.estimatedTokens)} tok)`)
      .join(', ');
    const more =
      r.bulkyImports.length > 3 ? ` <span class="hint">and ${r.bulkyImports.length - 3} more</span>` : '';
    findings.push(
      `<li><strong>${r.bulkyImports.length} large @-import(s)</strong>: ${sample}${more}` +
        `<div class="finding-action">→ consider summarizing or loading on demand</div></li>`
    );
  }

  const findingsBlock =
    findings.length > 0
      ? `<ul class="findings">${findings.join('')}</ul>`
      : '<p class="no-findings">✓ No issues</p>';

  return (
    `<div class="context-card">` +
    `<div class="context-card-header">` +
    `<span class="context-ws">${escapeHtml(r.workspaceName)}</span>` +
    `<span class="context-meta">${meta}</span>` +
    badge +
    `</div>` +
    findingsBlock +
    `</div>`
  );
}
```

- [ ] **Step 4: Confirm `escapeHtml` exists in `app.js`**

Run: `grep -n "function escapeHtml" src/dashboard/public/app.js`
Expected: Match found (it's used elsewhere in the file). If somehow not present, abort and ask.

- [ ] **Step 5: Add CSS for the cards and badges**

Append to `src/dashboard/public/styles.css`:

```css
/* Context health cards */
.context-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 10px;
  background: var(--bg-elev);
}
.context-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.context-ws {
  font-weight: 600;
  font-size: 14px;
}
.context-meta {
  flex: 1;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}
.badge.fresh { color: var(--text-dim); background: transparent; border: 1px solid var(--border); }
.badge.stale { color: var(--text-dim); background: var(--bg); border: 1px solid var(--border); }
.badge.drifting { color: var(--warn); background: transparent; border: 1px solid var(--warn); }
.findings {
  list-style: none;
  padding: 0;
  margin: 0;
}
.findings li {
  font-size: 13px;
  padding: 4px 0;
  border-top: 1px solid var(--border);
}
.findings li:first-child {
  border-top: none;
}
.finding-action {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
  margin-left: 8px;
}
.no-findings {
  font-size: 12px;
  color: var(--text-dim);
  margin: 0;
}
```

- [ ] **Step 6: Build and run the dashboard**

Run: `npm run dev:dashboard`
Wait for it to come up; the browser should open automatically. If not, visit http://localhost:3737 (or whatever port `dashboard.ts` defaults to).

- [ ] **Step 7: Visual verify the cards render**

Inspect the "CLAUDE.md health" section. Confirm:
- Per-workspace cards render in place of the old table
- Cards with findings show heading + meta + badge (`fresh` / `stale` / `drifting`)
- Findings list shows decaying sections, stale @-imports, bulky imports each with an action hint
- Workspaces without findings show "✓ No issues"
- Sort order: most findings first

If anything looks off, fix inline (CSS tweaks, missing data) and re-verify.

- [ ] **Step 8: Stop the dev server**

Ctrl+C in the terminal running `npm run dev:dashboard`.

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/public/index.html src/dashboard/public/app.js src/dashboard/public/styles.css
git commit -m "feat(dashboard): per-workspace findings cards replace bloat table

Each card shows the workspace name, mtime/age, fresh/stale/drifting badge,
and a list of specific findings (decaying sections by heading + line range,
stale @-imports, bulky @-imports) each with an inline action hint.
Sorted by finding count descending."
```

---

## Task 6: End-to-end manual verification + threshold tuning

**Files:**
- (None expected; only changes if thresholds need tuning)

- [ ] **Step 1: Run the full pipeline against real data**

Run: `npm run dev -- recommend`
Expected: Output includes:
- Decaying-section recs for any workspace whose CLAUDE.md has `## Recent Changes`, `## TODO`, etc.
- Drift recs for workspaces where mtime > 30d AND ≥5 sessions since
- Stale recs (only if no drift) for workspaces where mtime > 60d

Look at the output and assess:
- Are recs firing where you'd expect them to fire (per the audit context)?
- Are there false positives (e.g. legitimate "## Status" headings firing where they shouldn't)?
- Are there obvious misses?

- [ ] **Step 2: Run the dashboard and visually scan the cards**

Run: `npm run dev:dashboard`
Visit the running URL.

Confirm visually:
- Cards stack neatly
- Badge colors are readable in your theme (light + dark)
- Action hints render on their own line with dimmer text
- Long heading names don't break the layout

- [ ] **Step 3: If thresholds need tuning, edit the constants**

If false-positive rate is too high or too low, edit the constants at the top of `src/core/context-inspector.ts`:

```ts
const STALE_DAYS = 60;        // was 60 — increase if too many stale recs on stable workspaces
const DRIFT_DAYS = 30;        // was 30 — increase if too aggressive
const DRIFT_SESSIONS = 5;     // was 5 — increase if drift fires too easily
```

If the regex needs to drop a pattern (e.g. `status` is too greedy), edit `DECAYING_HEADING_PATTERNS` and re-run the unit tests to confirm they still pass with the new pattern (you may need to update tests).

Run after any changes: `npm test && npm run typecheck`

- [ ] **Step 4: Commit any tuning changes**

If you adjusted thresholds or the regex:

```bash
git add src/core/context-inspector.ts src/core/context-inspector.test.ts
git commit -m "tune(context): adjust thresholds based on real-data verification

Reasoning: <one-sentence why>"
```

If no changes were needed, skip this step.

- [ ] **Step 5: Update the project CLAUDE.md known-issues section**

Open `CLAUDE.md` (workspace root). The "Known issues / quick wins" section will now itself be flagged by the new detector — that's expected dogfood behavior. No action needed unless you want to migrate that content into a STATUS doc; document the choice either way.

---

## Self-Review Notes

Spec coverage:
- ✓ Decaying-state heading detector — Task 1 (extract + tests), Task 2 (wire into report), Task 3 (rec emitter), Task 4 (CLI), Task 5 (dashboard)
- ✓ Stale + drift — Task 2 (compute), Task 3 (rec emitter), Task 4 (CLI badge), Task 5 (dashboard badge)
- ✓ Per-workspace findings card — Task 5
- ✓ CLI surfaces findings — Task 4
- ✓ Existing recs (bloat, missing imports, bulky imports) untouched and still emitted — confirmed in Task 3 (only adds, no removals)
- ✓ Tests via `node:test` + `tsx --test`, no new deps — Task 1 step 1
- ✓ Real-data verification — Task 6
- Out of scope (per spec): cross-workspace duplication, generated-block detector, doc-index gap detector, falsifiable-claim detection
