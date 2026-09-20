import { describe, it, expect } from "vitest";
import { toJson, fromJson } from "@/lib/domain/json";
import { isTerminalJobStatus, JobStatus, TERMINAL_JOB_STATUSES, ACTIVE_JOB_STATUSES } from "@/lib/domain/enums";

describe("toJson / fromJson", () => {
  it("round-trips an object", () => {
    const value = { a: 1, b: ["x", "y"], c: { nested: true } };
    expect(fromJson(toJson(value), null)).toEqual(value);
  });

  it("returns the fallback for null/undefined input", () => {
    expect(fromJson(null, "fallback")).toBe("fallback");
    expect(fromJson(undefined, "fallback")).toBe("fallback");
  });

  it("returns the fallback for malformed JSON instead of throwing", () => {
    expect(fromJson("{not valid json", ["default"])).toEqual(["default"]);
  });

  it("toJson returns null for null/undefined rather than the string 'null'", () => {
    expect(toJson(null)).toBeNull();
    expect(toJson(undefined)).toBeNull();
  });
});

describe("job status classification", () => {
  it("every terminal status is classified as terminal", () => {
    for (const status of TERMINAL_JOB_STATUSES) {
      expect(isTerminalJobStatus(status)).toBe(true);
    }
  });

  it("every active status is classified as non-terminal", () => {
    for (const status of ACTIVE_JOB_STATUSES) {
      expect(isTerminalJobStatus(status)).toBe(false);
    }
  });

  it("terminal and active sets don't overlap", () => {
    const overlap = TERMINAL_JOB_STATUSES.filter((s) => (ACTIVE_JOB_STATUSES as string[]).includes(s));
    expect(overlap).toEqual([]);
  });

  it("covers every declared JobStatus value between the two sets", () => {
    const all = new Set([...TERMINAL_JOB_STATUSES, ...ACTIVE_JOB_STATUSES]);
    for (const value of Object.values(JobStatus)) {
      expect(all.has(value)).toBe(true);
    }
  });
});
