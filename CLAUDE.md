# token-insight

Personal tool that reads Claude Code's session JSONL logs from `~/.claude/projects/` and gives me usage observability + optimization recommendations across all my workspaces. Personal-paid by default — cost is the headline signal — with an opt-in IC profile that preserves the older "5-hour rate-limit windows during the workday" framing for company-subscription use.

CLI is `ti`. Bare invocation opens the dashboard. See README.md for full command list.

## Architecture

```
src/
├── cli.ts                       # commander-based entry; bare `ti` -> dashboard
├── core/
│   ├── types.ts                 # Session, SessionTurn, ToolCall, etc.
│   ├── jsonl-loader.ts          # walks ~/.claude/projects/, parses JSONL
│   ├── pricing.ts               # per-model $/Mtok table; cost is surfaced in personal profile
│   ├── profile.ts               # personal/ic presets: buckets, rate-limit framing, thresholds
│   ├── config.ts                # ~/.token-insight.json — profile choice + custom bucket overrides
│   ├── workspace-mapper.ts      # decode encoded paths; profile-driven workspace grouping
│   ├── aggregator.ts            # by workspace / day / model / group
│   ├── blocks.ts                # 5-hour rolling windows + active projection (IC-relevant)
│   ├── time-of-day.ts           # hour-of-day, day-of-week buckets
│   ├── waste-detector.ts        # flags outlier / cache-bloated / overlong sessions
│   ├── prompt-clusterer.ts      # cheap trigram-Jaccard clustering of user prompts
│   ├── context-inspector.ts     # CLAUDE.md size / stale @-imports / bulky imports
│   ├── file-reads.ts            # per-file Read tool-call frequency
│   └── recommendations.ts       # rolls up signals into actionable items; thresholds via active profile
├── commands/
│   ├── daily.ts week.ts workspaces.ts analyze.ts blocks.ts
│   ├── profile.ts               # `ti profile show|set <name>`
│   ├── recommend.ts             # headline command — prioritized actions
│   ├── context.ts               # CLAUDE.md inspection
│   ├── draft-skill.ts           # writes SKILL.md scaffold + a polish prompt
│   ├── dashboard.ts             # spins up local server + auto-opens browser
│   └── format.ts                # shared CLI rendering helpers
└── dashboard/
    ├── server.ts                # Express server, /api/report endpoint, 10s cache
    └── public/
        ├── index.html app.js styles.css   # vanilla JS + Chart.js via CDN
```

## Profiles

The active profile is a process-wide singleton, initialized once at CLI startup from `~/.token-insight.json`. Profile presets live in `src/core/profile.ts` and control:

- `knownBuckets` + `deepRollupBuckets` — how `workspace-mapper.ts` groups workspaces
- `rateLimitFraming` — whether the dashboard shows the active 5-hour window card, recent-blocks chart, and peak KPI tile; whether copy uses rate-limit language
- `costFraming` — whether model/context recommendations talk about dollar cost or rate-window cost
- `thresholds` — every numeric knob in `recommendations.ts` (Opus heavy %, CLAUDE.md bloat, bash hook minimums, etc.) is per-profile

Personal preset tightens cost-sensitive thresholds (Opus, CLAUDE.md bloat). IC preset preserves the original defaults.

Users can extend the active profile via `customKnownBuckets` / `customDeepRollupBuckets` in `~/.token-insight.json` without forking either preset.

## Conventions

- TypeScript strict, ESM modules, Node 18+
- No frontend build step — `public/` is served as-is
- `npm run build` runs `tsc` then copies `public/` into `dist/`
- Dev: `npm run dev -- <subcommand>` or `npm run dev:dashboard`
- Anything that reads from the active profile uses the `getActiveProfile()` sync getter — never an async config load — since it's called inside JSONL parsing

## Known issues / quick wins

- **Dashboard charts are oversized.** The canvases use `maintainAspectRatio: false` but their parent `.card` sections have no height constraint, so charts expand to fill huge vertical space on wide screens. Fix: wrap each `<canvas>` in a `<div class="chart-wrap">` with a fixed pixel height (e.g. 200–280px), `position: relative`, and let the canvas fill it 100%. Apply consistently in `src/dashboard/public/index.html` + add the class to `styles.css`.
- **Profile-scoped thresholds need real-usage tuning.** Personal defaults are guesses (Opus heavy at 25%, CLAUDE.md bloat at 3k/8k). Revisit after a week of real usage and tune `PERSONAL_THRESHOLDS` in `src/core/profile.ts`.
- **Threshold overrides aren't yet surfaced in config.** Per-profile thresholds live in `profile.ts`. Letting users override them via `~/.token-insight.json` (parallel to `customKnownBuckets`) is the next natural extension.

## Future work parked

- Embedding-based clustering to replace trigram (drop-in at `src/core/prompt-clusterer.ts`)
- Hook generators that emit working scripts (currently recommendations only suggest hooks would help, don't write them)
- Watch mode / desktop notifier when active window crosses 80% of recent peak (IC profile)
- Real Claude API call from `draft-skill` so the SKILL.md ships fully written
- Cost projections / budgets ("at this pace you'll spend $X this month") for personal profile

## When iterating

- Always run `npm run typecheck` after touching anything in `src/core/` since types ripple through commands and dashboard server
- The dashboard cache is 10s, so changes to recommendation logic won't show up immediately on refresh — restart the server (`Ctrl+C` and `ti` again) to be safe
- The `~/.claude/projects/` JSONL format isn't strictly versioned by Claude Code, so the parser is intentionally forgiving — preserve that when extending
- Profile is initialized once at startup; if you add an `initProfile()` consumer outside `cli.ts`, make sure it runs before any session loading
