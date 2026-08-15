import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const MAX_VIDEO_VERIFICATION_ATTEMPTS = 5;
const CODE_PATTERN = /^\d{6}$/;

export function validateVideoVerificationCode(code: string) {
  const normalized = code.trim();
  if (!CODE_PATTERN.test(normalized)) throw new Error("Enter the six-digit verification code shown in the video.");
  return normalized;
}

export function hashVideoVerificationCode(code: string, salt = randomBytes(16).toString("hex")) {
  const normalized = validateVideoVerificationCode(code);
  const digest = scryptSync(normalized, salt, 32).toString("hex");
  return `scrypt:${salt}:${digest}`;
}

export function matchesVideoVerificationCode(code: string, storedHash: string | null | undefined) {
  if (!storedHash) return false;
  const [algorithm, salt, expected] = storedHash.split(":");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const received = scryptSync(code.trim(), salt, 32).toString("hex");
  const receivedBytes = Buffer.from(received, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export function evaluateExternalVideoReturn(input: { startedAtMs: number; returnedAtMs: number; requiredDurationSeconds: number }) {
  const elapsedSeconds = Math.max(0, Math.floor((input.returnedAtMs - input.startedAtMs) / 1000));
  if (elapsedSeconds < input.requiredDurationSeconds) {
    return { eligible: false, elapsedSeconds, reason: "You returned before the required watch duration was completed." } as const;
  }
  return { eligible: true, elapsedSeconds, reason: null } as const;
}

export function nextVerificationAttemptState(currentAttempts: number, isCorrect: boolean) {
  if (isCorrect) return { attempts: currentAttempts, status: "passed" as const, locked: false };
  const attempts = currentAttempts + 1;
  return { attempts, status: attempts >= MAX_VIDEO_VERIFICATION_ATTEMPTS ? "locked" as const : "failed" as const, locked: attempts >= MAX_VIDEO_VERIFICATION_ATTEMPTS };
}
