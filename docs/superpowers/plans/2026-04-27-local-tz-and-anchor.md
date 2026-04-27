# Local TZ + Active-Window Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two pinpoint dashboard fixes — bucket `byDay` rollups by local calendar day instead of UTC; surface the active 5-hour window's `startedAt`/`endsAt` clock times in the active-panel footnote.

**Architecture:** Pure presentation-layer fixes. One small helper added in `src/core/aggregator.ts` and one line of bucketing code changed; one footnote string in `src/dashboard/public/app.js` extended to include the window's local-time range. No new modules, no new dependencies, no backend changes.

**Tech Stack:** TypeScript, Node 18+, vanilla browser JS. No test framework — verification is `npm run typecheck`, `ti week`, and visual inspection of the dashboard.

**Spec:** [`docs/superpowers/specs/2026-04-27-local-tz-and-anchor-design.md`](../specs/2026-04-27-local-tz-and-anchor-design.md)

---

### Task 1: Local-date bucketing in `byDay`

**Files:**
- Modify: `src/core/aggregator.ts`

- [ ] **Step 1: Add the `localYmd` helper**

In `src/core/aggregator.ts`, add the following helper function below the existing `addToBucket` helper (around line 42, before the `byWorkspace` export):

```typescript
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
```

This builds a `YYYY-MM-DD` string from a `Date`'s local components. Unlike `toISOString().slice(0, 10)`, it does not shift to UTC.

- [ ] **Step 2: Use the helper in `byDay`**

Replace this line in `byDay` (currently at `src/core/aggregator.ts:67`):

```typescript
const key = s.startedAt.toISOString().slice(0, 10);
```

with:

```typescript
const key = localYmd(s.startedAt);
```

Both the key and the label now use the local date. No other lines in `byDay` change.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes with no errors.

- [ ] **Step 4: Sanity-check the helper across edge cases**

From `/Users/johnmarchisin/conductor/workspaces/token-insight/karachi`, run:

```bash
npx tsx -e "
  // Re-declare locally to exercise the same logic; the source is private.
  function localYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  // 1) March 9, 2026 — DST transition in US
  const dst = new Date(2026, 2, 9, 1, 30); // local 1:30 AM
  // 2) End of month
  const eom = new Date(2026, 0, 31, 23, 59);
  // 3) Cross-year boundary
  const ny = new Date(2025, 11, 31, 23, 0);
  // 4) Plain afternoon
  const noon = new Date(2026, 3, 27, 14, 0);

  for (const [label, d] of [['DST 1:30 AM', dst], ['Jan 31 23:59', eom], ['NYE 11pm', ny], ['Apr 27 2pm', noon]]) {
    console.log(label, '->', localYmd(d));
  }
"
```

Expected output (timezone-dependent on the host but should be):
```
DST 1:30 AM -> 2026-03-09
Jan 31 23:59 -> 2026-01-31
NYE 11pm -> 2025-12-31
Apr 27 2pm -> 2026-04-27
```

If any output disagrees, the helper is wrong (most likely the `month + 1` is off, or `padStart` was forgotten).

- [ ] **Step 5: Commit**

```bash
git add src/core/aggregator.ts
git commit -m "fix(aggregator): bucket byDay rollups by local calendar day"
```

---

### Task 2: Surface window anchor times in the active-panel footnote

**Files:**
- Modify: `src/dashboard/public/app.js`

- [ ] **Step 1: Locate the active-workspaces line**

In `src/dashboard/public/app.js`, find the `renderActive(d)` function. The last line of the function currently reads:

```javascript
$('active-workspaces').textContent =
  'workspaces this window: ' + (a.workspaces?.length ? a.workspaces.join(', ') : '(none)');
```

(Currently around `app.js:196–198`.)

- [ ] **Step 2: Replace with anchor-time-aware footnote**

Replace those two lines with:

```javascript
const fmtClock = (d) =>
  new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const range = `${fmtClock(a.startedAt)} – ${fmtClock(a.endsAt)}`;
const wsList = a.workspaces?.length ? a.workspaces.join(', ') : null;
$('active-workspaces').textContent = wsList
  ? `window: ${range} · workspaces: ${wsList}`
  : `window: ${range}`;
```

Notes for the implementer:
- `a` is the variable already in scope (`const a = d.activeBlock` from earlier in `renderActive`). Don't redeclare.
- `a.startedAt` and `a.endsAt` come over the wire as ISO strings (the API serializes them via `JSON.stringify`); wrapping in `new Date(...)` parses them back to a `Date`. `toLocaleTimeString` uses the browser's locale and timezone automatically.
- The `hour: 'numeric'` option produces e.g. `11:13 AM` in `en-US` and `11:13` in 24-hour locales — both correct for the user's preference.
- The previous code path that fell back to `(none)` becomes the no-workspaces branch (`window: 11:13 AM – 4:13 PM`). That's intentionally a cleaner empty state than the old `(none)` literal.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes (this is a pure JS file, but the typecheck still runs over the TS portions).

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/app.js
git commit -m "fix(dashboard): show active window anchor times in local time"
```

---

## Self-review notes

- **Spec coverage:** Fix 1 is fully covered by Task 1. Fix 2 is fully covered by Task 2. Goals/Non-goals/Out-of-scope sections require no implementation steps.
- **Placeholders:** None. Every step shows the exact code/CSS/HTML to write.
- **Type/name consistency:** `localYmd` is a function name local to `aggregator.ts`, not exported. `fmtClock`, `range`, `wsList` are scoped inside `renderActive` only. The `a` and `d` variables are reused exactly as the existing function declared them.
- **Out-of-scope guardrails:** No changes to `time-of-day.ts`, `blocks.ts`, `commands/daily.ts`, `commands/week.ts`, or any other module. The single-line key-build change in `byDay` is the entire data-side surface.
