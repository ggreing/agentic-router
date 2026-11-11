// List prices per million tokens (spec 3.5, 2026-11).
// Same values as bench/config/estimates.json. Cost here is an API list-price equivalent;
// for subscription users it is an estimate, not a bill.

export interface ModelPrice { input: number; output: number; longPromptInput?: number; longPromptOutput?: number; longPromptOver?: number }

export const PRICING_PER_MTOK: Record<string, ModelPrice> = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, longPromptInput: 0.50, longPromptOutput: 2.50, longPromptOver: 100_000 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

/** Cache write is billed above input (1h cache = 2x, 5m cache = 1.25x); cache reads at 0.1x. */
export const CACHE_MULTIPLIER = { write1h: 2.0, write5m: 1.25, read: 0.1 } as const;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
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
  const usd = ((u.input_tokens ?? 0) * inP + write * inP + (u.cache_read_input_tokens ?? 0) * CACHE_MULTIPLIER.read * inP + (u.output_tokens ?? 0) * outP) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
