import { describe, it, expect } from "vitest";
import { parseAndValidate } from "../../src/services/statementService.js";
import { AppError } from "../../src/http/errors.js";

/**
 * No-DB unit tests for the statement-ask JSON validation (design §10, §10.1).
 * The LLM's reply is parsed and validated in CODE: a valid 4-type shape passes;
 * anything else (bad JSON, unknown type, missing/invalid dates, inverted range,
 * missing counterparty for type 1) maps to 422 UNSUPPORTED_QUESTION. This is
 * the guardrail the prompt-injection test relies on — a malformed or hostile
 * reply never reaches the SQL.
 */

function expectUnsupported(raw: string): void {
  try {
    parseAndValidate(raw);
    throw new Error(`expected UNSUPPORTED_QUESTION for ${raw}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("UNSUPPORTED_QUESTION");
    expect((err as AppError).httpStatus).toBe(422);
  }
}

describe("parseAndValidate (statement-ask schema)", () => {
  it("accepts a valid type-1 parse with a counterparty", () => {
    expect(
      parseAndValidate('{"type":1,"counterparty":"Rahul","from":"2026-08-01","to":"2026-08-31"}'),
    ).toEqual({ type: 1, counterparty: "Rahul", from: "2026-08-01", to: "2026-08-31" });
  });

  it("accepts valid type 2/3/4 parses without a counterparty", () => {
    for (const type of [2, 3, 4]) {
      expect(parseAndValidate(`{"type":${type},"from":"2026-08-01","to":"2026-08-31"}`)).toEqual({
        type,
        from: "2026-08-01",
        to: "2026-08-31",
      });
    }
  });

  it("rejects the mock's {type:99} no-match shape", () => {
    expectUnsupported('{"type":99}');
  });

  it("rejects unparseable text", () => {
    expectUnsupported("not json at all");
  });

  it("rejects an unknown type", () => {
    expectUnsupported('{"type":5,"from":"2026-08-01","to":"2026-08-31"}');
  });

  it("rejects missing or malformed dates", () => {
    expectUnsupported('{"type":2,"from":"2026-08-01"}');
    expectUnsupported('{"type":2,"from":"2026-13-99","to":"2026-08-31"}');
    expectUnsupported('{"type":2,"from":"08/01/2026","to":"08/31/2026"}');
  });

  it("rejects an inverted date range (from > to)", () => {
    expectUnsupported('{"type":2,"from":"2026-08-31","to":"2026-08-01"}');
  });

  it("rejects a type-1 parse missing a counterparty", () => {
    expectUnsupported('{"type":1,"from":"2026-08-01","to":"2026-08-31"}');
  });
});
