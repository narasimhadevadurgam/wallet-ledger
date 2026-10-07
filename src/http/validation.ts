import { z } from "zod";
import { InvalidAmountError, parseAmount } from "../money/money.js";
import { AppError } from "./errors.js";

/**
 * Request validation per design §8. Each body/query is parsed by a zod schema
 * before any DB work. A failure maps to the SPECIFIC catalogue code the design
 * assigns (not a blanket 400): amount problems -> INVALID_AMOUNT, currency
 * problems -> UNSUPPORTED_CURRENCY, from==to -> SAME_WALLET, everything else
 * (name/email/phone/note/limit/offset/question shape) -> VALIDATION_ERROR.
 *
 * The schemas use a branded sentinel string in `message` so `mapZodError` can
 * route a failing field to its code. This keeps the mapping declarative and
 * co-located with each rule.
 */

// Sentinels embedded in zod messages so we can map a field to a specific code.
const CODE_AMOUNT = "__INVALID_AMOUNT__";
const CODE_CURRENCY = "__UNSUPPORTED_CURRENCY__";
const CODE_SAME_WALLET = "__SAME_WALLET__";

/** A positive-integer id (path params or wallet ids), accepted as number or numeric string. */
const idSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const s = typeof v === "number" ? String(v) : v.trim();
    if (!/^\d+$/.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a positive integer id" });
      return z.NEVER;
    }
    const n = BigInt(s);
    if (n <= 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a positive integer id" });
      return z.NEVER;
    }
    return n;
  });

/**
 * Amount: integer paise > 0, <= 2^63-1, number must be a safe integer or a
 * numeric string. Delegates to money.parseAmount for the exact rules, then
 * additionally rejects zero (parseAmount allows 0; a money amount must be > 0).
 */
const amountSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    let parsed: bigint;
    try {
      parsed = parseAmount(v);
    } catch (err) {
      const detail = err instanceof InvalidAmountError ? err.message : "invalid amount";
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${CODE_AMOUNT}${detail}` });
      return z.NEVER;
    }
    if (parsed <= 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${CODE_AMOUNT}amount must be greater than 0` });
      return z.NEVER;
    }
    return parsed;
  });

export const createUserSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/, "phone must be E.164-ish (+? and 7-15 digits)"),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const createWalletSchema = z.object({
  currency: z.string().refine((c) => c === "INR", { message: `${CODE_CURRENCY}currency must be INR` }),
});
export type CreateWalletInput = z.infer<typeof createWalletSchema>;

export const amountBodySchema = z.object({
  amount: amountSchema,
});
export type AmountBodyInput = z.infer<typeof amountBodySchema>;

export const transferSchema = z
  .object({
    from_wallet_id: idSchema,
    to_wallet_id: idSchema,
    amount: amountSchema,
    note: z.string().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.from_wallet_id === val.to_wallet_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${CODE_SAME_WALLET}from and to wallet must differ`,
        path: ["to_wallet_id"],
      });
    }
  });
export type TransferInput = z.infer<typeof transferSchema>;

export const idParamSchema = z.object({ id: idSchema });

export const statementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type StatementQueryInput = z.infer<typeof statementQuerySchema>;

export const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type CursorQueryInput = z.infer<typeof cursorQuerySchema>;

export const askSchema = z.object({
  question: z.string().min(1).max(1000),
});
export type AskInput = z.infer<typeof askSchema>;

/**
 * Translate a ZodError into the specific AppError the design mandates. We look
 * for the branded sentinel in any issue message; the first matching sentinel
 * wins (amount/currency/same-wallet), otherwise it is a generic
 * VALIDATION_ERROR listing the offending fields.
 */
export function mapZodError(error: z.ZodError): AppError {
  for (const issue of error.issues) {
    if (issue.message.startsWith(CODE_AMOUNT)) {
      return new AppError("INVALID_AMOUNT", issue.message.slice(CODE_AMOUNT.length));
    }
    if (issue.message.startsWith(CODE_CURRENCY)) {
      return new AppError("UNSUPPORTED_CURRENCY", issue.message.slice(CODE_CURRENCY.length));
    }
    if (issue.message.startsWith(CODE_SAME_WALLET)) {
      return new AppError("SAME_WALLET", issue.message.slice(CODE_SAME_WALLET.length));
    }
  }
  const fields = error.issues
    .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`)
    .join("; ");
  return new AppError("VALIDATION_ERROR", `invalid request: ${fields}`);
}

/**
 * Parse `data` with `schema`, throwing the mapped AppError on failure. Typed on
 * the schema's OUTPUT so transform/coerce/default schemas (whose input differs
 * from output) are accepted; the return is the parsed output type.
 */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw mapZodError(result.error);
  }
  return result.data;
}
