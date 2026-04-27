# token-insight

Personal Claude Code usage tracker and optimizer. Built for one specific problem: **stop running out of usage in the middle of the workday**, and **stop paying tokens for things you should be paying for once** (skills, hooks, cached context).

Reads the JSONL session logs Claude Code writes to `~/.claude/projects/`. Nothing leaves your machine. No accounts, no telemetry.

## What it does

Two halves of the same problem.

**Observability** — where am I right now, and where am I heading?

- Live view of your active 5-hour rate window, with token velocity and a projected total at current pace
- Self-derived "ceiling" from your actual recent peak (since Anthropic doesn't publish the exact token limit per plan)
- Time-of-day heatmap so you can see when you typically burn the most tokens
- Per-workspace breakdown so you know which projects are eating your budget

**Optimization** — what should I change to use fewer tokens for the same outcome?

- **Skill candidates** — clusters your prompts to find recurring requests that should become reusable skills
- **CLAUDE.md bloat** — flags oversized context files, stale `@`-imports, and bulky imported files that load every session
- **High-frequency file reads** — finds files Claude re-reads many times per session (candidates for `@`-import in CLAUDE.md so they cache properly)
- **Subagent opportunities** — flags long sessions that should have offloaded exploration to a subagent
- **Model usage** — flags over-reliance on Opus when Sonnet would handle the work
- **Skill drafter** — turns a recurring cluster into a starter SKILL.md plus a polish prompt you paste into Claude Code to finish it

## Install

```bash
npm install
npm run build
npm link            # installs the `ti` command globally
```

For local development, `npm run dev -- <subcommand>`.

## Use

```bash
ti                          # opens the dashboard in your browser

ti recommend                # the headline command — actionable optimizations across all signals
ti recommend --kind skill   # filter to one category
ti recommend --days 30      # signals from the last N days only

ti blocks                   # live 5-hour rate-limit window view + recent windows
ti context                  # CLAUDE.md inspection: bloat, stale refs, bulky imports
ti context --workspace foo  # one workspace

ti analyze                  # raw waste detection + skill cluster list
ti analyze --workspace foo  # one workspace

ti draft-skill                       # list cluster numbers
ti draft-skill --cluster 3           # writes <slug>-SKILL.md + a polish prompt
ti draft-skill --cluster 3 --out ~/conductor/foo/skills/foo-thing/SKILL.md

ti daily                    # today's tokens across all workspaces
ti week                     # last 7 days
ti workspaces               # per-workspace tokens, all time
ti workspaces --group       # roll up by group (~/conductor/* -> conductor)
```

Add `--json` to any command for machine-readable output.

## What's actually happening under the hood

1. Walks `~/.claude/projects/`, parses every `.jsonl` session, including each turn's tool calls.
2. Decodes each project directory's encoded path back to the original workspace and groups it (anything under `~/conductor/<name>/...` rolls up under `<name>`; tweak `KNOWN_BUCKETS` in `src/core/workspace-mapper.ts`).
3. Builds rolling 5-hour blocks (the rate-window unit) and computes velocity + projection for the active one.
4. Reads each workspace's `CLAUDE.md` / `CLAUDE.local.md`, parses `@`-imports and markdown links, checks they exist and aren't bulky.
5. Aggregates Read/NotebookRead tool calls per file path to find re-read offenders.
6. Clusters user prompts via trigram-Jaccard similarity, ranks by total tokens.
7. The recommendations engine combines all of the above into severity-ranked, kind-tagged actionable items.

Dashboard caches data for 10s so clicking around stays snappy; the active-window view auto-refreshes every 30s.

## Extending

The clustering is deliberately cheap (trigram set comparison). Once you have enough usage history, swap it for embedding cosine similarity in `src/core/prompt-clusterer.ts` — the rest of the pipeline doesn't need to change.

Other natural extensions:

- Real Claude API call from `draft-skill` so the SKILL.md ships fully written, not just scaffolded
- Hook generators — emit hook scripts for the patterns found (e.g. SessionStart hook that pre-loads a high-read file)
- Watch mode — a desktop notifier when you cross 80% of your peak window
- Rules engine config in `~/.token-insight.json` so you can tune severity thresholds

## Stack

TypeScript, Node 18+, Express, Chart.js (CDN). No database, no auth, no telemetry. Pricing module is intact in `src/core/pricing.ts` but unused by default — flip a flag to bring cost views back if you ever switch off subscription billing.

## License

MIT, personal use.
