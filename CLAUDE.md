# token-insight

Personal tool that reads Claude Code's session JSONL logs from `~/.claude/projects/` and gives me usage observability + optimization recommendations across all my workspaces. I'm on a company subscription, so dollar cost is irrelevant — what matters is hitting 5-hour rate-limit windows during the workday and finding patterns to turn into reusable skills/hooks/CLAUDE.md tweaks.

CLI is `ti`. Bare invocation opens the dashboard. See README.md for full command list.

## Architecture

```
src/
├── cli.ts                       # commander-based entry; bare `ti` -> dashboard
├── core/
│   ├── types.ts                 # Session, SessionTurn, ToolCall, etc.
│   ├── jsonl-loader.ts          # walks ~/.claude/projects/, parses JSONL
│   ├── pricing.ts               # kept but unused (subscription, not API)
│   ├── workspace-mapper.ts      # decode encoded paths; ~/conductor/* rollup
│   ├── aggregator.ts            # by workspace / day / model / group
│   ├── blocks.ts                # 5-hour rolling windows + active projection
│   ├── time-of-day.ts           # hour-of-day, day-of-week buckets
│   ├── waste-detector.ts        # flags outlier / cache-bloated / overlong sessions
│   ├── prompt-clusterer.ts      # cheap trigram-Jaccard clustering of user prompts
│   ├── context-inspector.ts     # CLAUDE.md size / stale @-imports / bulky imports
│   ├── file-reads.ts            # per-file Read tool-call frequency
│   └── recommendations.ts       # rolls up signals into actionable items
├── commands/
│   ├── daily.ts week.ts workspaces.ts analyze.ts blocks.ts
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

## Conventions

- TypeScript strict, ESM modules, Node 18+
- No frontend build step — `public/` is served as-is
- `npm run build` runs `tsc` then copies `public/` into `dist/`
- Dev: `npm run dev -- <subcommand>` or `npm run dev:dashboard`
- Workspace grouping rules live in `src/core/workspace-mapper.ts` (`KNOWN_BUCKETS`)
- Recommendation thresholds live in `src/core/recommendations.ts` — tune these as you learn what's signal vs noise for your workflow

## Known issues / quick wins

- **Dashboard charts are oversized.** The canvases use `maintainAspectRatio: false` but their parent `.card` sections have no height constraint, so charts expand to fill huge vertical space on wide screens. Fix: wrap each `<canvas>` in a `<div class="chart-wrap">` with a fixed pixel height (e.g. 200–280px), `position: relative`, and let the canvas fill it 100%. Apply consistently in `src/dashboard/public/index.html` + add the class to `styles.css`.
- **Recommendation thresholds need tuning** for my real data. Defaults: bulky import = 4k tokens, high-read = 3 reads/session, long session = 60 turns, Opus-heavy = >40% of tokens. Adjust in `src/core/recommendations.ts` after a week of real usage.
- **Pricing module is unused** but still imported by `jsonl-loader.ts` for the per-turn `cost` field. Either zero it out or eventually rip cost from the data model.

## Future work parked

- Embedding-based clustering to replace trigram (drop-in at `src/core/prompt-clusterer.ts`)
- Hook generators that emit working scripts (currently recommendations only suggest hooks would help, don't write them)
- Watch mode / desktop notifier when active window crosses 80% of recent peak
- Real Claude API call from `draft-skill` so the SKILL.md ships fully written

## When iterating

- Always run `npm run typecheck` after touching anything in `src/core/` since types ripple through commands and dashboard server
- The dashboard cache is 10s, so changes to recommendation logic won't show up immediately on refresh — restart the server (`Ctrl+C` and `ti` again) to be safe
- The `~/.claude/projects/` JSONL format isn't strictly versioned by Claude Code, so the parser is intentionally forgiving — preserve that when extending
