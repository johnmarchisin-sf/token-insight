// Decode ~/.claude/projects/<encoded-name> back into a usable workspace path,
// and bucket workspaces into groups (e.g. everything under ~/conductor/ rolls up).

import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Claude Code encodes the cwd by replacing path separators and dots with `-`.
 * E.g. `/Users/john/conductor/foo.bar` -> `-Users-john-conductor-foo-bar`.
 *
 * The encoding is lossy (we can't tell `foo-bar` from `foo.bar` from `foo/bar`),
 * but in practice the reconstructed path almost always matches a real directory.
 * We use the leading `-` to anchor it to absolute root.
 */
export function decodeProjectDirName(encoded: string): string {
  if (encoded.startsWith('-')) {
    return '/' + encoded.slice(1).replace(/-/g, '/');
  }
  return encoded.replace(/-/g, '/');
}

export function workspaceNameFromPath(p: string): string {
  const seg = p.split('/').filter(Boolean);
  return seg[seg.length - 1] || p;
}

/**
 * Group a workspace into a bucket for rollups.
 *
 * Rules (in order):
 *   1. If under ~/conductor/<x>/...   -> group = "conductor"
 *   2. If under ~/<known-bucket>/...  -> group = that bucket
 *   3. Otherwise                       -> group = "other"
 *
 * Adjust KNOWN_BUCKETS to taste.
 */
const KNOWN_BUCKETS = ['conductor', 'projects', 'work', 'code', 'src'];

export function groupForWorkspace(workspacePath: string): string {
  const home = homedir();
  if (workspacePath.startsWith(home + '/')) {
    const rel = workspacePath.slice(home.length + 1);
    const first = rel.split('/')[0];
    if (KNOWN_BUCKETS.includes(first)) return first;
  }
  // Any path containing /conductor/ as a segment groups under conductor.
  if (workspacePath.split('/').includes('conductor')) return 'conductor';
  return 'other';
}

/**
 * If the workspace lives under ~/conductor/<name>/..., return <name> so we can
 * roll up subdirectories of a workspace under a single label. Otherwise return
 * the workspace's own short name.
 */
export function rollupNameForPath(workspacePath: string): string {
  const home = homedir();
  if (workspacePath.startsWith(home + '/')) {
    const rel = workspacePath.slice(home.length + 1);
    const parts = rel.split('/').filter(Boolean);
    if (parts.length >= 2 && KNOWN_BUCKETS.includes(parts[0])) {
      return parts[1];
    }
  }
  // Fallback: try matching /conductor/ anywhere in the path.
  const segs = workspacePath.split('/').filter(Boolean);
  const idx = segs.indexOf('conductor');
  if (idx >= 0 && idx < segs.length - 1) {
    return segs[idx + 1];
  }
  return workspaceNameFromPath(workspacePath);
}

export function defaultProjectsDir(): string {
  return path.join(homedir(), '.claude', 'projects');
}
