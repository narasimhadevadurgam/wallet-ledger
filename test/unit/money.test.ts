import { describe, it, expect } from "vitest";
import {
  parseAmount,
  serializeAmount,
  canonicalJson,
  sha256Hex,
  InvalidAmountError,
} from "../../src/money/money.js";

describe("parseAmount", () => {
  it("accepts a non-negative integer number", () => {
    expect(parseAmount(1000)).toBe(1000n);
    expect(parseAmount(0)).toBe(0n);
  });

  it("accepts a numeric string and normalizes leading zeros", () => {
    expect(parseAmount("1000")).toBe(1000n);
    expect(parseAmount("01000")).toBe(1000n);
    expect(parseAmount("0")).toBe(0n);
  });

  it("accepts a large value a JS number could not hold", () => {
    expect(parseAmount("9223372036854775807")).toBe(9223372036854775807n);
  });

  it("rejects non-integer numbers", () => {
    expect(() => parseAmount(10.5)).toThrow(InvalidAmountError);
  });

  it("rejects negative values", () => {
    expect(() => parseAmount(-1)).toThrow(InvalidAmountError);
    expect(() => parseAmount("-1")).toThrow(InvalidAmountError);
  });

  it("rejects unsafe-integer numbers (ask for a string instead)", () => {
    expect(() => parseAmount(2 ** 53)).toThrow(InvalidAmountError);
  });

  it("rejects values beyond BIGINT range", () => {
    expect(() => parseAmount("9223372036854775808")).toThrow(InvalidAmountError);
  });

  it("rejects non-numeric strings", () => {
    expect(() => parseAmount("1_000")).toThrow(InvalidAmountError);
    expect(() => parseAmount("abc")).toThrow(InvalidAmountError);
    expect(() => parseAmount("10.0")).toThrow(InvalidAmountError);
  });
});

describe("serializeAmount", () => {
  it("renders a bigint as a plain decimal string", () => {
    expect(serializeAmount(1000n)).toBe("1000");
    expect(serializeAmount(0n)).toBe("0");
  });
});

describe("canonicalJson", () => {
  it("sorts object keys lexicographically and drops whitespace", () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("normalizes money fields: 1000, '1000', '01000' collide", () => {
    const asNumber = canonicalJson({ amount: 1000 });
    const asString = canonicalJson({ amount: "1000" });
    const withZeros = canonicalJson({ amount: "01000" });
    expect(asNumber).toBe('{"amount":"1000"}');
    expect(asString).toBe(asNumber);
    expect(withZeros).toBe(asNumber);
  });

  it("NFC-normalizes strings so equivalent forms collide", () => {
    const composed = "é"; // U+00E9
    const decomposed = "e\u0301"; // e + combining acute
    expect(canonicalJson({ note: composed })).toBe(
      canonicalJson({ note: decomposed }),
    );
  });

  it("renders booleans and null as lowercase literals", () => {
    expect(canonicalJson({ held: true, voided: false, note: null })).toBe(
      '{"held":true,"note":null,"voided":false}',
    );
  });
});

describe("sha256Hex", () => {
  it("returns a lowercase 64-char hex digest", () => {
    const digest = sha256Hex("");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Known SHA-256 of the empty string.
    expect(digest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is stable for canonicalized bodies that differ only by key order", () => {
    const h1 = sha256Hex(canonicalJson({ amount: 1000, note: "hi" }));
    const h2 = sha256Hex(canonicalJson({ note: "hi", amount: "1000" }));
    expect(h1).toBe(h2);
  });
});
