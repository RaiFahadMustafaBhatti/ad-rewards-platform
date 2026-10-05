import { describe, expect, it } from "vitest";
import { generateResetToken, hashPassword, hashResetToken, validatePassword, verifyPassword } from "./passwords";

describe("password hashing", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correct-horse-123");
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword("correct-horse-123", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct-horse-123");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("produces unique salts per hash", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("rejects malformed hashes without throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("validatePassword", () => {
  it("requires at least 8 characters", () => {
    expect(validatePassword("short")).toMatch(/at least 8/);
    expect(validatePassword("long-enough-1")).toBeNull();
  });
});

describe("reset tokens", () => {
  it("generates tokens whose stored hash verifies", () => {
    const { token, tokenHash } = generateResetToken();
    expect(token).toHaveLength(64);
    expect(tokenHash).toBe(hashResetToken(token));
  });

  it("generates unique tokens", () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
