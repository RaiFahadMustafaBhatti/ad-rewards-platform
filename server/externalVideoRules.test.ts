import { describe, expect, it } from "vitest";
import { evaluateExternalVideoReturn, hashVideoVerificationCode, matchesVideoVerificationCode, nextVerificationAttemptState, validateVideoVerificationCode } from "./externalVideoRules";

describe("external video verification rules", () => {
  it("accepts only exactly six digits and stores a non-reversible verification hash", () => {
    expect(validateVideoVerificationCode("482731")).toBe("482731");
    expect(() => validateVideoVerificationCode("48273")).toThrow("six-digit");
    const hash = hashVideoVerificationCode("482731", "test-salt");
    expect(hash).not.toContain("482731");
    expect(matchesVideoVerificationCode("482731", hash)).toBe(true);
    expect(matchesVideoVerificationCode("482732", hash)).toBe(false);
  });

  it("uses server elapsed time to reject an early external return and permit a completed duration", () => {
    expect(evaluateExternalVideoReturn({ startedAtMs: 1_000, returnedAtMs: 59_999, requiredDurationSeconds: 60 })).toMatchObject({ eligible: false, elapsedSeconds: 58 });
    expect(evaluateExternalVideoReturn({ startedAtMs: 1_000, returnedAtMs: 61_000, requiredDurationSeconds: 60 })).toMatchObject({ eligible: true, elapsedSeconds: 60 });
  });

  it("locks a verification session on the fifth failed code without revealing partial code details", () => {
    expect(nextVerificationAttemptState(0, false)).toEqual({ attempts: 1, status: "failed", locked: false });
    expect(nextVerificationAttemptState(4, false)).toEqual({ attempts: 5, status: "locked", locked: true });
    expect(nextVerificationAttemptState(4, true)).toEqual({ attempts: 4, status: "passed", locked: false });
  });
});
