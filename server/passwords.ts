import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const SCRYPT_KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 8;

/** Validate a candidate password. Returns an error message or null when acceptable. */
export function validatePassword(plain: string): string | null {
  if (typeof plain !== "string" || plain.length < MIN_PASSWORD_LENGTH)
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (plain.length > 256) return "Password is too long.";
  return null;
}

/** Hash a password with scrypt + random salt. Format: scrypt$<saltHex>$<hashHex>. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(plain, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

/** Timing-safe password verification. Returns false for malformed hashes. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (typeof plain !== "string" || typeof stored !== "string") return false;
  const [algo, salt, hashHex] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hashHex) return false;
  try {
    const derived = (await scryptAsync(plain, salt, SCRYPT_KEYLEN)) as Buffer;
    const expected = Buffer.from(hashHex, "hex");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Generate a single-use reset token; only the SHA-256 hash is stored. */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1_000; // 1 hour

/** 6-digit email OTP: only the SHA-256 hash is ever stored. */
export const OTP_TTL_MS = 10 * 60 * 1_000; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;

export function generateOtpCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

/** Timing-safe comparison for OTP hashes. */
export function otpHashMatches(candidate: string, expectedHash: string): boolean {
  const a = Buffer.from(hashOtpCode(candidate), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
