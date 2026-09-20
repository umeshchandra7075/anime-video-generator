import { describe, it, expect } from "vitest";
import { creditCostForDuration, CREDIT_COSTS } from "@/lib/usage/creditPricing";
import { durationToSeconds } from "@/lib/domain/duration";
import { isPasswordStrongEnough } from "@/lib/auth/password";

describe("creditCostForDuration", () => {
  it("returns the configured cost for each known duration", () => {
    for (const [duration, cost] of Object.entries(CREDIT_COSTS)) {
      expect(creditCostForDuration(duration)).toBe(cost);
    }
  });

  it("falls back to the custom cost for an unknown duration string", () => {
    expect(creditCostForDuration("unknown-value")).toBe(CREDIT_COSTS.custom);
  });
});

describe("durationToSeconds", () => {
  it.each([
    ["30s", 30],
    ["1m", 60],
    ["3m", 180],
    ["5m", 300],
    ["10m", 600],
  ])("maps %s to %d seconds", (input, expected) => {
    expect(durationToSeconds(input)).toBe(expected);
  });
});

describe("isPasswordStrongEnough", () => {
  it("rejects short passwords", () => {
    expect(isPasswordStrongEnough("Ab1")).toBe(false);
  });

  it("rejects passwords missing a required character class", () => {
    expect(isPasswordStrongEnough("alllowercase1")).toBe(false); // no uppercase
    expect(isPasswordStrongEnough("ALLUPPERCASE1")).toBe(false); // no lowercase
    expect(isPasswordStrongEnough("NoDigitsHere")).toBe(false); // no digit
  });

  it("accepts a password meeting every requirement", () => {
    expect(isPasswordStrongEnough("Str0ngPassword")).toBe(true);
  });
});
