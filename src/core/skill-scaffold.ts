// Build a starter SKILL.md scaffold + polish prompt from a prompt cluster.
// Used by both the `ti draft-skill` CLI and the dashboard's inline drafter.

import { PromptCluster } from './types.js';

export interface SkillScaffold {
  slug: string;
  skillBody: string;
  polishPrompt: string;
}

const STOP = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'have', 'are',
  'you', 'your', 'can', 'will', 'should', 'would', 'could', 'all', 'any',
  'how', 'what', 'where', 'when', 'why', 'use', 'using', 'help', 'please',
]);

export function buildSkillScaffold(cluster: PromptCluster): SkillScaffold {
  const slug = makeSlug(cluster.representative);
  const skillBody = buildSkillBody(cluster, slug);
  const polishPrompt = buildPolishPrompt(cluster);
  return { slug, skillBody, polishPrompt };
}

export function makeSlug(rep: string): string {
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

function buildSkillBody(cluster: PromptCluster, slug: string): string {
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

function buildPolishPrompt(cluster: PromptCluster): string {
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

function truncate(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length <= n ? oneline : oneline.slice(0, n - 1) + '…';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
