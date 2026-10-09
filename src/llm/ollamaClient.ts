import type { LlmClient } from "./LlmClient.js";

/**
 * OllamaLlmClient (design §10). POSTs the built prompt to an Ollama server's
 * OpenAI-compatible chat-completions endpoint and returns the assistant's raw
 * text. Our code — never this client — parses and validates the reply. Switch
 * to this provider with `LLM_PROVIDER=ollama` (see `factory.ts`); the README
 * documents the switch.
 */
export interface OllamaOptions {
  /** Base URL, e.g. http://localhost:11434 (no trailing /v1). */
  url: string;
  /** Model name, e.g. llama3.1:8b. */
  model: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OllamaLlmClient implements LlmClient {
  private readonly endpoint: string;
  private readonly model: string;

  constructor(opts: OllamaOptions) {
    // Ollama exposes the OpenAI-compatible route at /v1/chat/completions.
    this.endpoint = `${opts.url.replace(/\/+$/, "")}/v1/chat/completions`;
    this.model = opts.model;
  }

  async complete(prompt: string): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        // Deterministic as the model allows: low temperature, no streaming.
        temperature: 0,
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`ollama request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("ollama response missing choices[0].message.content");
    }
    return content;
  }
}
