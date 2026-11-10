// Profile presets control which assumptions `ti` makes about your workspace
// layout and which signals it surfaces. `personal` is the generic default;
// `ic` preserves the legacy behavior tuned for company-subscription IC work
// (conductor-shaped rollups, 5-hour rate-limit framing).
//
// The active profile is a process-wide singleton initialized once at startup
// from persisted config (see config.ts). Sync getters keep call sites simple,
// since workspace-mapper is invoked during synchronous JSONL parsing.

export type ProfileName = 'personal' | 'ic';

/** Thresholds that shape which signals become recommendations. */
export interface RecommendationThresholds {
  /** Trigram-Jaccard similarity required to consider a cluster a match for an existing skill. */
  skillMatchOverlap: number;
  /** Min Explore-tool calls in a session before we recommend a subagent. */
  subagentExploreMin: number;
  /** Min recent (7d) members for a borderline-skill recommendation. */
  borderlineMinRecentSize: number;
  /** Min recent (7d) tokens for a borderline-skill recommendation. */
  borderlineMinRecentTokens: number;
  /** Bash-pattern hook thresholds. */
  bashHookMinCount: number;
  bashHookMinSessions: number;
  bashHookPostEditRatio: number;
  bashHookSessionStartMin: number;
  bashHookSessionStartRatio: number;
  /** Avg Explore calls per session in a cluster before we suggest a subagent skill. */
  clusterSubagentAvgExploreMin: number;
  /** CLAUDE.md token bloat thresholds — medium severity at >= mediumTokens, high at >= highTokens. */
  contextBloatMediumTokens: number;
  contextBloatHighTokens: number;
  /** Total imported tokens across bulky imports that promotes severity from medium to high. */
  bulkyImportHighTotal: number;
  /** Fraction of tokens on Opus that triggers a model-choice recommendation. */
  opusHeavyPct: number;
}

export interface ProfileSettings {
  name: ProfileName;
  /** Top-level dirs under $HOME used as workspace-group buckets. */
  knownBuckets: string[];
  /** For deep rollup: ~/<bucket>/<sub>/<project>/... rolls up to <project>. */
  deepRollupBuckets: Record<string, string[]>;
  /** When true, surface 5-hour rate-limit windows as a primary lens. */
  rateLimitFraming: boolean;
  /** Whether to frame model/context recommendations around dollar cost (vs. rate-window cost). */
  costFraming: boolean;
  thresholds: RecommendationThresholds;
}

// Defaults match the original `recommendations.ts` constants (IC-tuned).
const IC_THRESHOLDS: RecommendationThresholds = {
  skillMatchOverlap: 0.5,
  subagentExploreMin: 15,
  borderlineMinRecentSize: 3,
  borderlineMinRecentTokens: 10_000,
  bashHookMinCount: 5,
  bashHookMinSessions: 2,
  bashHookPostEditRatio: 0.5,
  bashHookSessionStartMin: 5,
  bashHookSessionStartRatio: 0.5,
  clusterSubagentAvgExploreMin: 10,
  contextBloatMediumTokens: 4_000,
  contextBloatHighTokens: 10_000,
  bulkyImportHighTotal: 20_000,
  opusHeavyPct: 0.4,
};

// Personal-paid users care about $$ per token. Tighten the cost-sensitive
// thresholds (Opus share, context bloat) so the same signal that's borderline
// on a subscription becomes actionable when you're paying retail.
const PERSONAL_THRESHOLDS: RecommendationThresholds = {
  ...IC_THRESHOLDS,
  contextBloatMediumTokens: 3_000,
  contextBloatHighTokens: 8_000,
  opusHeavyPct: 0.25,
};

const PRESETS: Record<ProfileName, ProfileSettings> = {
  personal: {
    name: 'personal',
    knownBuckets: ['projects', 'code', 'src', 'work'],
    deepRollupBuckets: {},
    rateLimitFraming: false,
    costFraming: true,
    thresholds: PERSONAL_THRESHOLDS,
  },
  ic: {
    name: 'ic',
    knownBuckets: ['conductor', 'projects', 'work', 'code', 'src'],
    deepRollupBuckets: { conductor: ['workspaces', 'production', 'sandbox'] },
    rateLimitFraming: true,
    costFraming: false,
    thresholds: IC_THRESHOLDS,
  },
};

export const PROFILE_NAMES: ProfileName[] = ['personal', 'ic'];
export const DEFAULT_PROFILE: ProfileName = 'personal';

let active: ProfileSettings = PRESETS[DEFAULT_PROFILE];

export function setActiveProfile(name: ProfileName): void {
  active = PRESETS[name];
}

/**
 * Replace the active profile with arbitrary settings (preset merged with any
 * user overrides). Use `setActiveProfile(name)` if you don't need overrides.
 */
export function setActiveProfileSettings(settings: ProfileSettings): void {
  active = settings;
}

export function getActiveProfile(): ProfileSettings {
  return active;
}

export function getProfilePreset(name: ProfileName): ProfileSettings {
  return PRESETS[name];
}

export function isValidProfileName(s: string): s is ProfileName {
  return (PROFILE_NAMES as string[]).includes(s);
}

/**
 * Produce an effective ProfileSettings by overlaying user-provided extra
 * buckets onto a preset. Custom values are additive — known buckets are
 * de-duped, deep-rollup subs are merged per bucket.
 */
export function mergeProfile(
  name: ProfileName,
  extra: { knownBuckets?: string[]; deepRollupBuckets?: Record<string, string[]> }
): ProfileSettings {
  const base = PRESETS[name];
  const known = new Set(base.knownBuckets);
  for (const b of extra.knownBuckets ?? []) known.add(b);
  const deep: Record<string, string[]> = { ...base.deepRollupBuckets };
  for (const [bucket, subs] of Object.entries(extra.deepRollupBuckets ?? {})) {
    const merged = new Set(deep[bucket] ?? []);
    for (const s of subs) merged.add(s);
    deep[bucket] = [...merged];
  }
  return { ...base, knownBuckets: [...known], deepRollupBuckets: deep };
}
