# Local-date bucketing + active-window anchor display

## Problem

Two unrelated dashboard bugs surfaced while reviewing real usage:

1. **Daily chart bucketed in UTC.** `byDay` in `src/core/aggregator.ts` keys per-day rollups by `s.startedAt.toISOString().slice(0, 10)`, which is the UTC date. For a user in Eastern, a session at 9pm EDT keys as the next UTC day. The "Daily tokens" chart labels and the `ti week` rollup show off-by-one days for late-evening activity.
2. **Active-window anchor invisible.** The "Active 5-hour window" panel shows `elapsed`/`remaining` as durations but never the actual clock time when the window opened or when it closes. There's no way to reconcile token-insight's data anchor with Anthropic's own rate-limit reset clock — making the panel feel "stuck" when the user's data anchor and Anthropic's window happen to diverge.

## Goals

- `byDay` rollups bucket by the user's local calendar day, not UTC.
- Active-window panel surfaces both `startedAt` and `endsAt` in the browser's local time so the user can compare to Anthropic's rate-limit clock.
- No new dependencies. No new server endpoints. No new modules.

## Non-goals

- Reading Anthropic's real rate-limit state. No public API exists in the JSONL data.
- A separate "stale window" indicator. Just surfacing the anchor times is enough to self-diagnose; we don't add another UI element.
- Changing block detection logic in `src/core/blocks.ts`. Window resets are still anchored to the first token-impactful turn after the previous block's `endsAt`. Same behavior, better visibility.
- Touching `byHourOfDay` / `byDayHour` — those already use `getHours()` / `getDay()` (local), no bug there.
- The "Daily tokens" chart x-axis tick rotation, label format, or any other rendering tweak.

## Design

### Fix 1: Local-date bucketing in `byDay`

In `src/core/aggregator.ts`, add a small helper alongside the other internal helpers:

```ts
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
```

Replace the single line in `byDay` that builds the key:

```ts
// before
const key = s.startedAt.toISOString().slice(0, 10);
// after
const key = localYmd(s.startedAt);
```

The label remains the same string as the key (current pattern), so chart labels read e.g. `2026-04-27` in the user's timezone. No call-site changes elsewhere.

### Fix 2: Surface window anchor in the active panel

In `src/dashboard/public/app.js:renderActive`, augment the existing `active-workspaces` footnote so it also shows the window's clock-time range. Today the line reads:

```
workspaces this window: token-insight, foo
```

After the change it reads:

```
window: 11:13 AM – 4:13 PM · workspaces: token-insight, foo
```

The data is already in `d.activeBlock.startedAt` and `d.activeBlock.endsAt`. Format with the browser's `toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })` so it respects the user's locale and timezone.

When `a.workspaces` is empty, the line collapses to:

```
window: 11:13 AM – 4:13 PM
```

(The current code already handles the empty-workspaces case as `(none)`; we keep that fallback unchanged.)

No changes to the active-grid stat tiles. No changes to the warning band. No backend change.

## Files touched

- `src/core/aggregator.ts` — add `localYmd` helper, use it in `byDay`.
- `src/dashboard/public/app.js` — extend the line written to `#active-workspaces`.

## Verification

This project has no unit test framework. Verification:

1. `npm run typecheck` passes.
2. From the working directory, run `ti week`. Confirm the rows correspond to your local calendar dates (no off-by-one for sessions that ran late evening).
3. `ti` opens the dashboard. Confirm:
   - "Daily tokens" chart x-axis labels are local-correct dates.
   - "Active 5-hour window" footnote starts with `window: <local start> – <local end>` and the times are in the browser's timezone.
4. Quick manual check via `node -e` to confirm `localYmd` produces what we expect across DST and end-of-month edges (a few date inputs).

## Out of scope

- Slice B (recommendation UX + cluster denylist + thumbs-up/down) — picks up after this lands.
- Slice C (phase-2 optimization signals) — later.
- Anything in `time-of-day.ts`, `blocks.ts`, `commands/daily.ts`, etc.
