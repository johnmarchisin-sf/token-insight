// Take a prompt cluster and emit a starter SKILL.md you can iterate on.
//
// We don't try to fully synthesize the skill — we extract obvious signals
// (recurring verbs/nouns, example trigger phrases) and output a scaffold,
// plus a "polish prompt" you can paste back into Claude Code to have it
// flesh out the body.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadAllSessions } from '../core/jsonl-loader.js';
import { clusterPrompts } from '../core/prompt-clusterer.js';
import { bold, dim } from './format.js';

export interface DraftSkillOpts {
  cluster?: number;
  out?: string;
  days?: number;
}

export async function runDraftSkill(opts: DraftSkillOpts): Promise<void> {
  const since = opts.days ? new Date(Date.now() - opts.days * 24 * 60 * 60_000) : undefined;
  const sessions = await loadAllSessions(since ? { since } : {});
  const clusters = clusterPrompts(sessions, { topN: 25 });

  if (clusters.length === 0) {
    console.error('No clusters found. Try `ti analyze` first to confirm there are recurring patterns.');
    process.exit(1);
  }

  if (!opts.cluster) {
    // List clusters for the user to pick from.
    console.log(bold('Pick a cluster to draft a skill for:'));
    console.log();
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      console.log(`  ${i + 1}. ${c.size}× repetitions, ${formatTokens(c.totalTokens)} tokens`);
      console.log(`     ${truncate(c.representative, 100)}`);
    }
    console.log();
    console.log(dim('Run `ti draft-skill --cluster <n>` to scaffold one.'));
    return;
  }

  const idx = opts.cluster - 1;
  if (idx < 0 || idx >= clusters.length) {
    console.error(`Cluster ${opts.cluster} out of range (1..${clusters.length}).`);
    process.exit(1);
  }
  const cluster = clusters[idx];

  const slug = makeSlug(cluster.representative);
  const skillBody = buildSkillBody(cluster, slug);
  const polishPrompt = buildPolishPrompt(cluster);

  const outPath = opts.out ?? path.resolve(process.cwd(), `${slug}-SKILL.md`);
  await fs.writeFile(outPath, skillBody, 'utf8');
  const promptPath = outPath.replace(/SKILL\.md$/, 'polish-prompt.md');
  await fs.writeFile(promptPath, polishPrompt, 'utf8');

  console.log(bold(`Drafted skill scaffold: ${outPath}`));
  console.log(dim(`Polish prompt:           ${promptPath}`));
  console.log();
  console.log('Next: open the polish prompt in Claude Code and let Claude finish the skill body using your real workflow.');
}

function buildSkillBody(cluster: { size: number; totalTokens: number; representative: string; examplePrompts: string[]; workspaces: string[] }, slug: string): string {
  const triggers = cluster.examplePrompts
    .slice(0, 8)
    .map((p) => `- "${truncate(p, 140)}"`)
    .join('\n');

  return `---
name: ${slug}
description: TODO — one sentence triggering description. Mention the verbs and nouns from the trigger phrases below so Claude knows when to use this.
---

# ${humanize(slug)}

> **Auto-drafted by token-insight** from a cluster of ${cluster.size} similar prompts (${formatTokens(cluster.totalTokens)} tokens combined). Edit before using.

## When to use this skill

Trigger phrases observed in your usage:

${triggers}

## What this skill should do

TODO — describe the procedure that should run when triggered. Currently you're typing variations of the prompts above; codify the canonical workflow here so Claude doesn't have to re-derive it each time.

## Reference inputs

TODO — list any files, paths, or environment details Claude needs to know about. Strong candidates: configs, schemas, or rules that you currently re-explain in each prompt.

## Output expectations

TODO — what should the deliverable look like? File written? Summary printed? Issue created?

## Notes

- Workspaces this pattern came from: ${cluster.workspaces.join(', ')}
- Representative example prompt:
  > ${truncate(cluster.representative, 300)}
`;
}

function buildPolishPrompt(cluster: { representative: string; examplePrompts: string[]; size: number; totalTokens: number }): string {
  const examples = cluster.examplePrompts.slice(0, 8).map((p, i) => `${i + 1}. ${p}`).join('\n\n');
  return `# Polish this skill draft

token-insight noticed I keep making this kind of request (${cluster.size}× so far, ${formatTokens(cluster.totalTokens)} tokens spent). I want to turn it into a reusable skill so I stop typing variants of the same prompt.

## What I keep asking

${examples}

## What I want

Read the SKILL.md scaffold I just generated alongside this file. Then:

1. Replace the TODO sections with concrete content that codifies what you've been doing for me when I make these requests.
2. Tighten the description so it triggers reliably on the trigger phrases above but not on unrelated requests.
3. If a procedure has clear deterministic steps, write them as numbered steps. If parts are judgment calls, leave them as prose.
4. Flag any place where you'd benefit from me providing more context (rules, examples, file paths I usually mean).

Ask me clarifying questions before you finalize anything important.
`;
}

function makeSlug(rep: string): string {
  const s = rep
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 4)
    .join('-');
  return s || 'untitled-skill';
}

function humanize(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const STOP = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'have', 'are',
  'you', 'your', 'can', 'will', 'should', 'would', 'could', 'all', 'any',
  'how', 'what', 'where', 'when', 'why', 'use', 'using', 'help', 'please',
]);

function truncate(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length <= n ? oneline : oneline.slice(0, n - 1) + '…';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
