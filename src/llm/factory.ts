import type { LlmClient } from "./LlmClient.js";
import { MockLlmClient } from "./mockClient.js";
import { OllamaLlmClient } from "./ollamaClient.js";

/** The LLM provider selection the factory understands (design §10). */
export type LlmProvider = "mock" | "ollama";

/** Inputs the factory needs; sourced from AppConfig at the entrypoints. */
export interface LlmFactoryConfig {
  provider: LlmProvider;
  ollamaUrl: string;
  ollamaModel: string;
}

/**
 * Pick the LLM implementation from config (design §10). Default is `mock`
 * (deterministic, offline). `ollama` posts to a local Ollama server. The
 * selection is the ONLY place provider wiring lives; callers depend on the
 * `LlmClient` interface only.
 */
export function createLlmClient(config: LlmFactoryConfig): LlmClient {
  switch (config.provider) {
    case "ollama":
      return new OllamaLlmClient({ url: config.ollamaUrl, model: config.ollamaModel });
    case "mock":
    default:
      return new MockLlmClient();
  }
}
