// CLI: take a prompt cluster and emit a starter SKILL.md you can iterate on.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadAllSessions } from '../core/jsonl-loader.js';
import { clusterPrompts } from '../core/prompt-clusterer.js';
import { buildSkillScaffold } from '../core/skill-scaffold.js';
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
  const { slug, skillBody, polishPrompt } = buildSkillScaffold(cluster);

  const outPath = opts.out ?? path.resolve(process.cwd(), `${slug}-SKILL.md`);
  await fs.writeFile(outPath, skillBody, 'utf8');
  const promptPath = outPath.replace(/SKILL\.md$/, 'polish-prompt.md');
  await fs.writeFile(promptPath, polishPrompt, 'utf8');

  console.log(bold(`Drafted skill scaffold: ${outPath}`));
  console.log(dim(`Polish prompt:           ${promptPath}`));
  console.log();
  console.log('Next: open the polish prompt in Claude Code and let Claude finish the skill body using your real workflow.');
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
