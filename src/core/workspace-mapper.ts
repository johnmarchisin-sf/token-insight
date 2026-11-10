// Decode ~/.claude/projects/<encoded-name> back into a usable workspace path,
// and bucket workspaces into groups (e.g. everything under ~/conductor/ rolls up).

import { homedir } from 'node:os';
import path from 'node:path';
import { getActiveProfile } from './profile.js';

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
 * Group a workspace into a bucket for rollups, driven by the active profile.
 *
 * Rules (in order):
 *   1. If under ~/<deep-rollup-bucket>/...    -> group = that bucket
 *   2. If under ~/<known-bucket>/...          -> group = that bucket
 *   3. If any path segment matches a deep-rollup bucket name (handles paths
 *      outside $HOME) -> group = that bucket
 *   4. Otherwise                               -> group = "other"
 */
export function groupForWorkspace(workspacePath: string): string {
  const profile = getActiveProfile();
  const home = homedir();
  const deepRollup = Object.keys(profile.deepRollupBuckets);

  if (workspacePath.startsWith(home + '/')) {
    const rel = workspacePath.slice(home.length + 1);
    const first = rel.split('/')[0];
    if (profile.knownBuckets.includes(first)) return first;
    if (deepRollup.includes(first)) return first;
  }
  // Catch paths outside $HOME that still live under one of the deep-rollup
  // buckets (e.g. an absolute path that contains /conductor/ as a segment).
  const segs = workspacePath.split('/').filter(Boolean);
  for (const bucket of deepRollup) {
    if (segs.includes(bucket)) return bucket;
  }
  return 'other';
}

/**
 * Roll up a workspace path to a stable label.
 *
 * Profiles can declare deep-rollup buckets: for ~/<bucket>/<sub>/<project>/...,
 * the <project> segment becomes the label (used by IC's conductor layout where
 * many workspace directories share a project). For ordinary known buckets, the
 * label is the immediate child segment. Falls back to the directory's basename.
 */
export function rollupNameForPath(workspacePath: string): string {
  const profile = getActiveProfile();
  const home = homedir();

  if (workspacePath.startsWith(home + '/')) {
    const rel = workspacePath.slice(home.length + 1);
    const parts = rel.split('/').filter(Boolean);
    for (const [bucket, subs] of Object.entries(profile.deepRollupBuckets)) {
      if (parts.length >= 3 && parts[0] === bucket && subs.includes(parts[1])) {
        return parts[2];
      }
    }
    if (parts.length >= 2 && profile.knownBuckets.includes(parts[0])) {
      return parts[1];
    }
    if (parts.length >= 2 && Object.keys(profile.deepRollupBuckets).includes(parts[0])) {
      return parts[1];
    }
  }
  // Last-resort: locate any deep-rollup bucket name as a path segment and use
  // the next segment as the label.
  const segs = workspacePath.split('/').filter(Boolean);
  for (const bucket of Object.keys(profile.deepRollupBuckets)) {
    const idx = segs.indexOf(bucket);
    if (idx >= 0 && idx < segs.length - 1) {
      return segs[idx + 1];
    }
  }
  return workspaceNameFromPath(workspacePath);
}

export function defaultProjectsDir(): string {
  return path.join(homedir(), '.claude', 'projects');
}
