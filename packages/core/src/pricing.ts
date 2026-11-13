// List prices per million tokens (spec 3.5), as published at https://platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-11-13: model table, cache hit multipliers, fast mode table). bench/config/estimates.json keeps its
// own copy for the bench planner. Cost here is an API list-price equivalent; for subscription users it is an
// estimate, not a bill.

export interface ModelPrice {
  input: number; output: number; longPromptInput?: number; longPromptOutput?: number; longPromptOver?: number;
  cacheRead?: number;   // multiplier on input for cache reads; default CACHE_MULTIPLIER.read
  /** Fast mode (usage.speed "fast"): every token category at this multiple; the caching multipliers apply on top. */
  fast?: number;
}

export const PRICING_PER_MTOK: Record<string, ModelPrice> = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, longPromptInput: 0.50, longPromptOutput: 2.50, longPromptOver: 100_000 },
  // cache reads at 0.05x for Sonnet/Opus 5.5 (the published rate; it also fits Claude Code's own cost figures over
  // the decision-107 runs exactly)
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.05 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05, fast: 2 },   // fast: $8 / $40
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.025, fast: 2 },  // fast: $16 / $80
};

/** Cache writes are billed above input (5m cache 1.25x, 1h cache 2x); cache reads at 0.1x unless the model sets cacheRead. */
export const CACHE_MULTIPLIER = { write1h: 2.0, write5m: 1.25, read: 0.1 } as const;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  /** "fast" when the request ran in fast mode (the API reports it in usage); anything else is standard. */
  speed?: string;
}

/** USD for one usage block. Unknown models return null (the caller records tokens only). */
export function costUsd(modelId: string, u: Usage): number | null {
  const p = PRICING_PER_MTOK[modelId];
  if (!p) return null;
  const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const long = p.longPromptOver !== undefined && prompt > p.longPromptOver;
  const inP = long ? p.longPromptInput! : p.input;
  const outP = long ? p.longPromptOutput! : p.output;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens;
  const write = w1h !== undefined || w5m !== undefined
    ? (w1h ?? 0) * CACHE_MULTIPLIER.write1h + (w5m ?? 0) * CACHE_MULTIPLIER.write5m
    : (u.cache_creation_input_tokens ?? 0) * CACHE_MULTIPLIER.write5m;
  // fast mode: every category at the model's fast multiple (a model without fast pricing stays at its standard rates)
  const speed = u.speed === 'fast' ? (p.fast ?? 1) : 1;
  const usd = speed * ((u.input_tokens ?? 0) * inP + write * inP + (u.cache_read_input_tokens ?? 0) * (p.cacheRead ?? CACHE_MULTIPLIER.read) * inP + (u.output_tokens ?? 0) * outP) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
