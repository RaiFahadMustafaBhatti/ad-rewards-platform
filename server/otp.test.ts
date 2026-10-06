import { describe, expect, it } from "vitest";
import { generateOtpCode, hashOtpCode, otpHashMatches, OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "./passwords";

describe("email OTP helpers", () => {
  it("generates 6-digit numeric codes", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it("generates distinct codes across calls", () => {
    const codes = new Set(Array.from({ length: 20 }, generateOtpCode));
    expect(codes.size).toBeGreaterThan(1);
  });

  it("hashes deterministically and matches timing-safely", () => {
    const code = "482916";
    const hash = hashOtpCode(code);
    expect(hash).toBe(hashOtpCode(code));
    expect(otpHashMatches(code, hash)).toBe(true);
    expect(otpHashMatches("482917", hash)).toBe(false);
    expect(otpHashMatches(" 482916 ", hash)).toBe(true);
  });

  it("rejects tampered hashes", () => {
    const hash = hashOtpCode("123456");
    const tampered = `${"0"}${hash.slice(1)}`;
    expect(otpHashMatches("123456", tampered)).toBe(false);
    expect(otpHashMatches("123456", "not-hex")).toBe(false);
  });

  it("uses a 10-minute TTL and 5-attempt limit", () => {
    expect(OTP_TTL_MS).toBe(10 * 60 * 1_000);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });
});
