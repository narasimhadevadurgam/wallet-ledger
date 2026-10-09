/**
 * The single LLM seam (design §10). Everything the system asks of a language
 * model goes through `complete(prompt)` and comes back as a raw string that
 * OUR code then parses and validates. The interface is deliberately tiny: the
 * LLM never receives or returns SQL and never decides money movement — it only
 * (a) parses a statement question into JSON and (b) explains an already-fired
 * risk flag. See `factory.ts` for provider selection (default `mock`).
 */
export interface LlmClient {
  /** Send a fully-built prompt string, resolve with the model's raw text reply. */
  complete(prompt: string): Promise<string>;
}
