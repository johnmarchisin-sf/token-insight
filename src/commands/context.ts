import { loadAllSessions } from '../core/jsonl-loader.js';
import { inspectAllWorkspaces, inspectGlobal } from '../core/context-inspector.js';
import { fmtTokens, table, bold, dim, warn } from './format.js';

export interface ContextOpts {
  json?: boolean;
  workspace?: string;
}

export async function runContext(opts: ContextOpts): Promise<void> {
  const sessions = await loadAllSessions();
  let reports = await inspectAllWorkspaces(sessions);
  const global = await inspectGlobal();
  if (opts.workspace) reports = reports.filter((r) => r.workspaceName === opts.workspace);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ global, workspaces: reports }, null, 2) + '\n');
    return;
  }

  console.log(bold('Global context'));
  if (!global.exists) {
    console.log(dim(`  ~/.claude/CLAUDE.md does not exist`));
  } else {
    console.log(
      `  ~/.claude/CLAUDE.md  ${global.lines} lines  ~${fmtTokens(global.estimatedTokens)} tokens` +
        (global.estimatedTokens > 4000 ? '  ' + warn('(bloated)') : '')
    );
  }
  console.log();

  if (reports.length === 0) {
    console.log(dim('No workspace CLAUDE.md files found.'));
    return;
  }

  console.log(bold('Workspace context'));
  console.log(
    table(
      reports.map((r) => ({
        workspace: r.workspaceName,
        lines: String(r.files.reduce((s, f) => s + f.lines, 0)),
        tokens: fmtTokens(r.totalEstimatedTokens),
        missing: String(r.missingImports.length),
        bulky: String(r.bulkyImports.length),
      })),
      ['workspace', 'lines', 'tokens', 'missing', 'bulky']
    )
  );

  for (const r of reports) {
    if (r.missingImports.length === 0 && r.bulkyImports.length === 0) continue;
    console.log();
    console.log(bold(`Issues in ${r.workspaceName}`));
    if (r.missingImports.length > 0) {
      console.log(dim('  Missing references:'));
      for (const m of r.missingImports) {
        console.log(`    • ${m.reference}` + (m.resolvedPath ? dim(` -> ${m.resolvedPath}`) : ''));
      }
    }
    if (r.bulkyImports.length > 0) {
      console.log(dim('  Bulky imports (>4k tokens):'));
      for (const b of r.bulkyImports) {
        console.log(`    • ${b.reference}  ${b.lines} lines  ~${fmtTokens(b.estimatedTokens)} tokens`);
      }
    }
  }
}
