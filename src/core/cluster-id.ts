// Stable identity helpers for prompt clusters.
//
// `clusterIdFor` produces a 12-char sha1 prefix of the cluster representative's
// normalized text. Stable across runs as long as the representative text
// doesn't change. Used as the persistence key for the denylist.
//
// `jaccard` is the same set-similarity used by the clusterer; we re-export it
// here so the recommendations engine and CLI can match denylisted clusters
// even when the representative text drifts (a cluster's trigrams stay
// substantially similar even when a longer prompt joins and bumps the rep).

import { createHash } from 'node:crypto';

export function clusterIdFor(normalizedRep: string): string {
  return createHash('sha1').update(normalizedRep, 'utf8').digest('hex').slice(0, 12);
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  const [small, big] = A.size < B.size ? [A, B] : [B, A];
  for (const x of small) if (big.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Set-overlap coefficient: |A ∩ B| / min(|A|, |B|).
 *
 * Unlike Jaccard, this isn't penalized when one set is much larger than the
 * other — useful when comparing a short cluster trigram set against a long
 * skill-description trigram set, where Jaccard would be capped at
 * ~smaller/larger even on perfect overlap.
 */
export function overlapCoefficient(a: Iterable<string>, b: Iterable<string>): number {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  const denom = Math.min(A.size, B.size);
  if (denom === 0) return 0;
  let inter = 0;
  const [small, big] = A.size < B.size ? [A, B] : [B, A];
  for (const x of small) if (big.has(x)) inter++;
  return inter / denom;
}

export interface DenylistMatchInput {
  id: string;
  trigrams: string[];
}
export interface DenylistEntryShape {
  id: string;
  trigrams: string[];
}

/**
 * Returns the matching denylist entry if the cluster is denylisted (by exact
 * id match OR by Jaccard similarity >= threshold against any entry's trigrams).
 * Returns null otherwise.
 */
export function findDenylistMatch<T extends DenylistEntryShape>(
  cluster: DenylistMatchInput,
  denylist: T[],
  similarityThreshold = 0.7
): T | null {
  for (const entry of denylist) {
    if (entry.id === cluster.id) return entry;
  }
  for (const entry of denylist) {
    if (jaccard(cluster.trigrams, entry.trigrams) >= similarityThreshold) return entry;
  }
  return null;
}
