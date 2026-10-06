import { z } from "zod";

/**
 * Environment schema. DATABASE_URL is required for any DB-touching path
 * (migrate, server, worker); unit tests do not load config and need no DB.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3000),
  LLM_PROVIDER: z.enum(["mock", "ollama"]).default("mock"),
  OLLAMA_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().min(1).default("llama3.1:8b"),
  // Nightly at 02:00 by default (min hour dom mon dow).
  RECON_CRON: z.string().min(1).default("0 2 * * *"),
  ADMIN_TOKEN: z.string().min(1).optional(),
  IDEMPOTENCY_CLEANUP_HOURS: z.coerce.number().int().positive().default(24),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Parse and validate process.env into a typed config object.
 * Throws a clear, aggregated error if any variable is invalid or missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
