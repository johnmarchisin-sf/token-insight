#!/usr/bin/env node
import { Command } from 'commander';
import { runDaily } from './commands/daily.js';
import { runWeek } from './commands/week.js';
import { runWorkspaces } from './commands/workspaces.js';
import { runAnalyze } from './commands/analyze.js';
import { runDashboard } from './commands/dashboard.js';
import { runBlocks } from './commands/blocks.js';
import { runRecommend } from './commands/recommend.js';
import { runContext } from './commands/context.js';
import { runDraftSkill } from './commands/draft-skill.js';
import { runUndeny } from './commands/undeny.js';
import { runProfileShow, runProfileSet } from './commands/profile.js';
import { initProfile } from './core/config.js';

const program = new Command();

program
  .name('ti')
  .description('token-insight: Claude Code usage tracking + waste detection across all workspaces')
  .version('0.1.0');

program
  .command('daily')
  .description('Today\'s spend across all workspaces')
  .option('--json', 'Output JSON instead of a table')
  .option('--date <YYYY-MM-DD>', 'Specific day to report on')
  .action(async (opts) => {
    await runDaily(opts);
  });

program
  .command('week')
  .description('Last N days of spend (default 7)')
  .option('--json', 'Output JSON instead of a table')
  .option('--days <n>', 'How many days back to include', (v) => parseInt(v, 10), 7)
  .action(async (opts) => {
    await runWeek(opts);
  });

program
  .command('workspaces')
  .description('Spend broken down by workspace')
  .option('--json', 'Output JSON instead of a table')
  .option('--days <n>', 'Limit to last N days (default: all time)', (v) => parseInt(v, 10))
  .option('--group', 'Also show rollup by workspace group (e.g. conductor)')
  .action(async (opts) => {
    await runWorkspaces(opts);
  });

program
  .command('analyze')
  .description('Detect high-waste sessions and surface skill candidates')
  .option('--json', 'Output JSON instead of a table')
  .option('--days <n>', 'Limit to last N days', (v) => parseInt(v, 10))
  .option('--workspace <name>', 'Limit to a single workspace')
  .option('--top-clusters <n>', 'Max clusters to show', (v) => parseInt(v, 10))
  .action(async (opts) => {
    await runAnalyze(opts);
  });

program
  .command('recommend')
  .alias('rec')
  .description('Concrete optimization recommendations across all signals')
  .option('--json', 'Output JSON instead of formatted text')
  .option('--days <n>', 'Limit signals to last N days', (v) => parseInt(v, 10))
  .option('--kind <k>', 'Filter by kind (skill, context, hook, subagent, model, session)')
  .option('--show-hidden', 'Include clusters previously hidden via 👎 / "Mark as created"')
  .action(async (opts) => {
    await runRecommend(opts);
  });

program
  .command('context')
  .description('Inspect CLAUDE.md files for bloat, stale references, and bulky imports')
  .option('--json', 'Output JSON instead of formatted text')
  .option('--workspace <name>', 'Limit to a single workspace')
  .action(async (opts) => {
    await runContext(opts);
  });

program
  .command('draft-skill')
  .description('Scaffold a SKILL.md from a recurring prompt cluster')
  .option('--cluster <n>', 'Cluster index (run `ti analyze` to find these)', (v) => parseInt(v, 10))
  .option('--out <path>', 'Output path for the SKILL.md (default: ./<slug>-SKILL.md)')
  .option('--days <n>', 'Limit clustering window to last N days', (v) => parseInt(v, 10))
  .action(async (opts) => {
    await runDraftSkill(opts);
  });

program
  .command('undeny <id>')
  .description('Remove a cluster from the denylist (run `ti recommend --show-hidden` to find ids; prefix matches accepted)')
  .action(async (id) => {
    await runUndeny(id);
  });

program
  .command('blocks')
  .description('5-hour usage windows (active + recent) — most useful when bumping up against subscription rate limits')
  .option('--json', 'Output JSON instead of a formatted view')
  .option('--recent <n>', 'How many recent windows to show', (v) => parseInt(v, 10), 14)
  .option('--lookback-days <n>', 'How many days back to derive your peak window from', (v) => parseInt(v, 10), 30)
  .action(async (opts) => {
    await runBlocks(opts);
  });

program
  .command('dashboard')
  .description('Launch the local dashboard (browser auto-opens)')
  .option('--port <n>', 'Port to listen on', (v) => parseInt(v, 10), 7842)
  .option('--no-open', 'Do not auto-open the browser')
  .action(async (opts) => {
    await runDashboard(opts);
  });

const profileCmd = program
  .command('profile')
  .description('Show or change the active profile (personal | ic)');
profileCmd
  .command('show', { isDefault: true })
  .description('Print the active profile and its settings')
  .option('--json', 'Output JSON instead of formatted text')
  .action(async (opts) => {
    await runProfileShow(opts);
  });
profileCmd
  .command('set <name>')
  .description('Set the active profile (personal | ic)')
  .action(async (name: string) => {
    await runProfileSet(name);
  });

async function main(): Promise<void> {
  await initProfile();
  if (process.argv.length <= 2) {
    await runDashboard({});
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
