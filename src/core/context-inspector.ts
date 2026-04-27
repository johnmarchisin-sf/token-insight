// Inspect CLAUDE.md (and CLAUDE.local.md) for each workspace and the global
// ~/.claude/CLAUDE.md. Surfaces context bloat, stale @-imports, and oversized
// referenced files.
//
// "CLAUDE.md and friends are loaded into every session — every line in there
// is a tax on every prompt." That's the framing.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { Session } from './types.js';

export interface ContextFile {
  filePath: string;
  exists: boolean;
  bytes: number;
  lines: number;
  estimatedTokens: number;   // ~bytes/4 — close enough for triage
  lastModified?: Date;
}

export interface MissingImport {
  fromFile: string;
  reference: string;
  resolvedPath?: string;
}

export interface BulkyImport {
  fromFile: string;
  reference: string;
  resolvedPath: string;
  bytes: number;
  lines: number;
  estimatedTokens: number;
}

export interface ContextReport {
  workspacePath: string;
  workspaceName: string;
  files: ContextFile[];                // CLAUDE.md and CLAUDE.local.md found
  totalEstimatedTokens: number;
  missingImports: MissingImport[];
  bulkyImports: BulkyImport[];
}

export interface GlobalContextReport {
  filePath: string;
  exists: boolean;
  bytes: number;
  lines: number;
  estimatedTokens: number;
}

const CONTEXT_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'];
const TOKEN_PER_BYTE_ESTIMATE = 0.25; // rough; English text ≈ 4 bytes/token

/** Inspect a single workspace's CLAUDE.md(s). */
export async function inspectWorkspace(workspacePath: string, workspaceName: string): Promise<ContextReport | null> {
  const files: ContextFile[] = [];
  const missingImports: MissingImport[] = [];
  const bulkyImports: BulkyImport[] = [];

  for (const name of CONTEXT_NAMES) {
    const fp = path.join(workspacePath, name);
    const f = await statContextFile(fp);
    if (f.exists) {
      files.push(f);
      // Parse @-mentions / file references.
      const content = await safeRead(fp);
      const refs = extractFileReferences(content);
      for (const ref of refs) {
        const resolved = resolveReference(workspacePath, ref);
        if (!resolved) {
          missingImports.push({ fromFile: fp, reference: ref });
          continue;
        }
        const f2 = await statContextFile(resolved);
        if (!f2.exists) {
          missingImports.push({ fromFile: fp, reference: ref, resolvedPath: resolved });
        } else if (f2.estimatedTokens >= 4_000) {
          bulkyImports.push({
            fromFile: fp,
            reference: ref,
            resolvedPath: resolved,
            bytes: f2.bytes,
            lines: f2.lines,
            estimatedTokens: f2.estimatedTokens,
          });
        }
      }
    }
  }

  if (files.length === 0 && missingImports.length === 0) return null;

  const totalEstimatedTokens = files.reduce((s, f) => s + f.estimatedTokens, 0);
  return {
    workspacePath,
    workspaceName,
    files,
    totalEstimatedTokens,
    missingImports,
    bulkyImports,
  };
}

export async function inspectGlobal(): Promise<GlobalContextReport> {
  const fp = path.join(homedir(), '.claude', 'CLAUDE.md');
  const f = await statContextFile(fp);
  return {
    filePath: fp,
    exists: f.exists,
    bytes: f.bytes,
    lines: f.lines,
    estimatedTokens: f.estimatedTokens,
  };
}

/** Inspect every workspace seen in the loaded sessions, deduped. */
export async function inspectAllWorkspaces(sessions: Session[]): Promise<ContextReport[]> {
  const seen = new Map<string, string>(); // path -> name
  for (const s of sessions) seen.set(s.workspacePath, s.workspaceName);
  const out: ContextReport[] = [];
  for (const [p, n] of seen) {
    const r = await inspectWorkspace(p, n);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.totalEstimatedTokens - a.totalEstimatedTokens);
}

async function statContextFile(fp: string): Promise<ContextFile> {
  try {
    const stat = await fs.stat(fp);
    if (!stat.isFile()) return { filePath: fp, exists: false, bytes: 0, lines: 0, estimatedTokens: 0 };
    const content = await fs.readFile(fp, 'utf8').catch(() => '');
    const lines = content ? content.split('\n').length : 0;
    return {
      filePath: fp,
      exists: true,
      bytes: stat.size,
      lines,
      estimatedTokens: Math.round(stat.size * TOKEN_PER_BYTE_ESTIMATE),
      lastModified: stat.mtime,
    };
  } catch {
    return { filePath: fp, exists: false, bytes: 0, lines: 0, estimatedTokens: 0 };
  }
}

async function safeRead(fp: string): Promise<string> {
  try {
    return await fs.readFile(fp, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Extract file references from a CLAUDE.md. Matches:
 *   - @path/to/file        (Claude Code's @-import syntax)
 *   - inline references like ./foo.md or relative.ts that look like file paths
 *
 * Tuned for false positives over false negatives — we'll resolve and verify.
 */
function extractFileReferences(content: string): string[] {
  const refs = new Set<string>();
  // @-imports: @path or @./path (require word/path char after @)
  for (const m of content.matchAll(/(?<![\w/.-])@([./]?[\w./-]+\.[a-zA-Z0-9]+)/g)) {
    refs.add(m[1]);
  }
  // Markdown links / inline mentions of obvious local files
  for (const m of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = m[1].split('#')[0];
    if (!href.startsWith('http') && !href.startsWith('mailto:') && href.includes('.')) {
      refs.add(href);
    }
  }
  return [...refs];
}

function resolveReference(workspacePath: string, ref: string): string | undefined {
  if (ref.startsWith('/')) return ref;
  if (ref.startsWith('~/')) return path.join(homedir(), ref.slice(2));
  return path.resolve(workspacePath, ref);
}
