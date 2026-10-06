import { createHash } from "node:crypto";

/** Largest value representable by a signed 64-bit integer (BIGINT max). */
const BIGINT_MAX = 9223372036854775807n; // 2^63 - 1

/**
 * Thrown when an amount is not a non-negative integer within BIGINT range.
 * Mapped to a 400 INVALID_AMOUNT response by the HTTP layer (later FEAT).
 */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

/**
 * Parse a client-supplied amount (JSON number or numeric string) into a
 * `bigint` number of paise. Rejects non-integers, negatives, and anything
 * beyond BIGINT range.
 */
export function parseAmount(input: number | string): bigint {
  if (typeof input === "number") {
    if (!Number.isInteger(input)) {
      throw new InvalidAmountError(`amount must be an integer, got ${input}`);
    }
    if (!Number.isSafeInteger(input)) {
      throw new InvalidAmountError(
        "amount exceeds safe integer range; send it as a string",
      );
    }
    if (input < 0) {
      throw new InvalidAmountError("amount must be non-negative");
    }
    return BigInt(input);
  }

  if (typeof input === "string") {
    // Canonical integer: optional single leading zero only when value is 0.
    // Accept plain digit strings (allow leading zeros, normalize them away).
    if (!/^\d+$/.test(input)) {
      throw new InvalidAmountError(
        `amount must be a non-negative integer string, got "${input}"`,
      );
    }
    const value = BigInt(input);
    if (value > BIGINT_MAX) {
      throw new InvalidAmountError("amount exceeds BIGINT range");
    }
    return value;
  }

  throw new InvalidAmountError("amount must be a number or numeric string");
}

/** Serialize a bigint amount to its canonical decimal string for the JSON boundary. */
export function serializeAmount(b: bigint): string {
  return b.toString();
}

/** Keys that hold money and must be normalized to a canonical bigint string. */
const MONEY_KEYS = new Set(["amount", "fee", "fee_paise", "balance"]);

/**
 * Recursively normalize a parsed JSON value per design §11.1:
 * - money fields -> canonical bigint decimal string
 * - strings -> NFC
 * - object keys -> sorted lexicographically (UTF-8 code-unit order)
 * - booleans/null -> native (serialize as lowercase literals)
 */
function normalize(value: unknown, key?: string): unknown {
  if (value === null) return null;

  if (typeof value === "string") {
    if (key !== undefined && MONEY_KEYS.has(key)) {
      return serializeAmount(parseAmount(value));
    }
    return value.normalize("NFC");
  }

  if (typeof value === "number") {
    if (key !== undefined && MONEY_KEYS.has(key)) {
      return serializeAmount(parseAmount(value));
    }
    return value;
  }

  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      out[k] = normalize(obj[k], k);
    }
    return out;
  }

  return value;
}

/**
 * Produce the canonical JSON string for a parsed request body (design §11.1):
 * parse-then-normalize, money fields to canonical bigint strings, keys sorted
 * lexicographically, no insignificant whitespace, NFC strings. The output is
 * hashed by sha256Hex to form body_hash.
 */
export function canonicalJson(body: unknown): string {
  return JSON.stringify(normalize(body));
}

/** Lowercase 64-char hex SHA-256 of the UTF-8 bytes of `s`. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
