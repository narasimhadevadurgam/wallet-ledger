import type { Pool } from "pg";
import { query } from "../db/query.js";
import { AppError } from "../http/errors.js";
import type { CreateUserInput } from "../http/validation.js";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  phone: string;
  kyc_status: string;
}

/**
 * Create a user. kyc_status defaults to 'pending' at the DB level. email/phone
 * are UNIQUE; a duplicate surfaces as a Postgres 23505 which we map to a
 * VALIDATION_ERROR (the create is idempotency-exempt per design §8, so we do
 * not dedupe — we simply report the conflict).
 */
export async function createUser(pool: Pool, input: CreateUserInput): Promise<UserRecord> {
  try {
    const result = await query<UserRecord>(
      pool,
      `INSERT INTO users (name, email, phone)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, phone, kyc_status`,
      [input.name, input.email, input.phone],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError("INTERNAL", "user insert returned no row");
    }
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError("VALIDATION_ERROR", "email or phone already in use");
    }
    throw err;
  }
}

/** True when `err` is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505";
}
