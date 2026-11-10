# token-insight

Personal Claude Code usage tracker and optimizer. Reads the JSONL session logs Claude Code writes to `~/.claude/projects/` and gives you observability into where your tokens go plus actionable recommendations for cutting waste. Nothing leaves your machine. No accounts, no telemetry.

Built around one question: **what should I change so I get the same outcome from Claude Code for fewer tokens?** That matters whether you're paying retail for your own API/subscription usage (default) or trying to avoid rate-limit windows on a company plan (IC profile).

## What it does

Two halves of the same problem.

**Observability** — where am I right now, and where am I heading?

- Per-day, per-week, per-workspace, per-model token + cost breakdowns
- Time-of-day heatmap so you can see when you typically use the most tokens
- (IC profile) Live view of your active 5-hour rate window, with velocity and a projected total at current pace, plus a self-derived ceiling from your actual recent peak

**Optimization** — what should I change to use fewer tokens for the same outcome?

- **Skill candidates** — clusters your prompts to find recurring requests that should become reusable skills
- **CLAUDE.md bloat** — flags oversized context files, stale `@`-imports, and bulky imported files that load every session
- **High-frequency file reads** — finds files Claude re-reads many times per session (candidates for `@`-import in CLAUDE.md so they cache properly)
- **Subagent opportunities** — flags long sessions that should have offloaded exploration to a subagent
- **Model usage** — flags over-reliance on Opus when Sonnet would handle the work at a fraction of the cost
- **Skill drafter** — turns a recurring cluster into a starter SKILL.md plus a polish prompt you paste into Claude Code to finish it

## Install

```bash
npm install
npm run build
npm link            # installs the `ti` command globally
```

For local development, `npm run dev -- <subcommand>`.

## Profiles

`ti` ships with two presets that change which signals are emphasized and how thresholds are tuned:

- **personal** (default) — for paying-out-of-pocket users. Cost is surfaced everywhere, Opus-heavy threshold tightened, CLAUDE.md bloat thresholds tightened. No workspace rollup is assumed.
- **ic** — for company-subscription IC work. Surfaces 5-hour rate-limit windows as a primary lens. Ships with a `~/conductor/<sub>/<project>/...` deep rollup convention.

```bash
ti profile show           # see the active profile and its effective settings
ti profile set ic         # switch to the IC profile
ti profile set personal   # back to default
```

Profile choice and overrides persist in `~/.token-insight.json`. To add custom workspace buckets without forking either preset, edit that file:

```json
{
  "profile": "personal",
  "customKnownBuckets": ["sandbox", "experiments"],
  "customDeepRollupBuckets": { "github": ["myorg"] }
}
```

`customKnownBuckets` is additive over the preset; `customDeepRollupBuckets` is merged per-bucket.

## Use

```bash
ti                          # opens the dashboard in your browser

ti recommend                # the headline command — actionable optimizations across all signals
ti recommend --kind skill   # filter to one category
ti recommend --days 30      # signals from the last N days only

ti context                  # CLAUDE.md inspection: bloat, stale refs, bulky imports
ti context --workspace foo  # one workspace

ti analyze                  # raw waste detection + skill cluster list
ti analyze --workspace foo  # one workspace

ti draft-skill                       # list cluster numbers
ti draft-skill --cluster 3           # writes <slug>-SKILL.md + a polish prompt
ti draft-skill --cluster 3 --out path/to/SKILL.md

ti daily                    # today's tokens + cost across all workspaces
ti week                     # last 7 days
ti workspaces               # per-workspace tokens + cost, all time
ti workspaces --group       # roll up by workspace group

ti blocks                   # 5-hour usage windows — useful when bumping up against subscription rate limits
```

Add `--json` to any command for machine-readable output.

## What's actually happening under the hood

1. Walks `~/.claude/projects/`, parses every `.jsonl` session, including each turn's tool calls.
2. Decodes each project directory's encoded path back to the original workspace and groups it by the active profile's known buckets / deep-rollup rules.
3. (IC profile) Builds rolling 5-hour blocks (the rate-window unit) and computes velocity + projection for the active one.
4. Reads each workspace's `CLAUDE.md` / `CLAUDE.local.md`, parses `@`-imports and markdown links, checks they exist and aren't bulky.
5. Aggregates Read/NotebookRead tool calls per file path to find re-read offenders.
6. Clusters user prompts via trigram-Jaccard similarity, ranks by total tokens.
7. The recommendations engine combines all of the above into severity-ranked, kind-tagged actionable items. Thresholds are profile-scoped — personal tightens cost-sensitive ones (Opus share, CLAUDE.md bloat).

Dashboard caches data for 10s so clicking around stays snappy.

## Extending

The clustering is deliberately cheap (trigram set comparison). Once you have enough usage history, swap it for embedding cosine similarity in `src/core/prompt-clusterer.ts` — the rest of the pipeline doesn't need to change.

Other natural extensions:

- Real Claude API call from `draft-skill` so the SKILL.md ships fully written, not just scaffolded
- Hook generators — emit hook scripts for the patterns found (e.g. SessionStart hook that pre-loads a high-read file)
- Watch mode — a desktop notifier when you cross 80% of your peak window (IC profile)
- Profile-scoped threshold overrides in `~/.token-insight.json` so you can tune severity without editing source

## Stack

TypeScript, Node 18+, Express, Chart.js (CDN). No database, no auth, no telemetry.

## License

MIT, personal use.
