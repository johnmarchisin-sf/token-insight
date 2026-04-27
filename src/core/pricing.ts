// Per-million-token prices for Claude models.
// Verify against https://www.anthropic.com/pricing periodically and update.
// Cache write defaults to 1.25x input, cache read to 0.1x input where not specified.

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

interface ModelEntry {
  prefix: string; // matched against model string with startsWith
  pricing: ModelPricing;
}

const MODELS: ModelEntry[] = [
  // Claude 4.x family
  {
    prefix: 'claude-opus-4',
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  },
  {
    prefix: 'claude-sonnet-4',
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  },
  {
    prefix: 'claude-haiku-4',
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4, cacheWritePerMTok: 1.0, cacheReadPerMTok: 0.08 },
  },
  // Claude 3.5/3.7 family (historical sessions)
  {
    prefix: 'claude-3-7-sonnet',
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  },
  {
    prefix: 'claude-3-5-sonnet',
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  },
  {
    prefix: 'claude-3-5-haiku',
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4, cacheWritePerMTok: 1.0, cacheReadPerMTok: 0.08 },
  },
  {
    prefix: 'claude-3-opus',
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  },
  {
    prefix: 'claude-3-sonnet',
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  },
  {
    prefix: 'claude-3-haiku',
    pricing: { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheWritePerMTok: 0.3, cacheReadPerMTok: 0.03 },
  },
];

const FALLBACK: ModelPricing = {
  // Use Sonnet-tier as a sane fallback so unknown models don't read as $0.
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
};

export function pricingFor(model: string | undefined): ModelPricing {
  if (!model) return FALLBACK;
  const m = model.toLowerCase();
  for (const entry of MODELS) {
    if (m.startsWith(entry.prefix)) return entry.pricing;
  }
  return FALLBACK;
}

export function costForUsage(
  model: string | undefined,
  usage: { input: number; output: number; cacheWrite: number; cacheRead: number }
): number {
  const p = pricingFor(model);
  return (
    (usage.input * p.inputPerMTok) / 1_000_000 +
    (usage.output * p.outputPerMTok) / 1_000_000 +
    (usage.cacheWrite * p.cacheWritePerMTok) / 1_000_000 +
    (usage.cacheRead * p.cacheReadPerMTok) / 1_000_000
  );
}
