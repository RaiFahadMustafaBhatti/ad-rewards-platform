export const PAKISTAN_MOBILE_PATTERN = /^(?:\+92|92|0)3\d{9}$/;
export const PAYMENT_SCREENSHOT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_PAYMENT_SCREENSHOT_BYTES = 5 * 1024 * 1024;

export type WithdrawalQuote = {
  amountPaisa: number;
  feePaisa: number;
  netAmountPaisa: number;
};

export function isValidPakistanMobile(phone: string) {
  return PAKISTAN_MOBILE_PATTERN.test(phone.replace(/[\s-]/g, ""));
}

export function calculateWithdrawalQuote(
  amountPaisa: number,
  minimumWithdrawalPaisa: number,
  feePaisa: number,
  maximumWithdrawalPaisa = 0,
): WithdrawalQuote {
  if (!Number.isInteger(amountPaisa) || amountPaisa <= 0) {
    throw new Error("Enter a valid withdrawal amount.");
  }
  if (!Number.isInteger(minimumWithdrawalPaisa) || minimumWithdrawalPaisa < 0) {
    throw new Error("The minimum withdrawal setting is invalid.");
  }
  if (!Number.isInteger(feePaisa) || feePaisa < 0) {
    throw new Error("The withdrawal fee setting is invalid.");
  }
  if (!Number.isInteger(maximumWithdrawalPaisa) || maximumWithdrawalPaisa < 0) {
    throw new Error("The maximum withdrawal setting is invalid.");
  }
  if (amountPaisa < minimumWithdrawalPaisa) {
    throw new Error("The requested amount is below the minimum withdrawal.");
  }
  if (maximumWithdrawalPaisa > 0 && amountPaisa > maximumWithdrawalPaisa) {
    throw new Error("The requested amount is above the maximum withdrawal.");
  }
  if (amountPaisa <= feePaisa) {
    throw new Error("The requested amount must exceed the withdrawal fee.");
  }

  return { amountPaisa, feePaisa, netAmountPaisa: amountPaisa - feePaisa };
}

export function maskAccountNumber(accountNumber: string) {
  const trimmed = accountNumber.trim();
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${"•".repeat(Math.max(0, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

export function validatePaymentScreenshot(file: {
  name: string;
  type: string;
  bytes: number;
}) {
  if (!PAYMENT_SCREENSHOT_TYPES.has(file.type)) {
    throw new Error("Payment proof must be a JPG, PNG, or WebP image.");
  }
  if (!Number.isInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_PAYMENT_SCREENSHOT_BYTES) {
    throw new Error("Payment proof must be no larger than 5 MB.");
  }
  const normalizedName = file.name.trim().toLowerCase();
  if (!/\.(jpe?g|png|webp)$/.test(normalizedName)) {
    throw new Error("The payment proof file extension is not allowed.");
  }
}

export function evaluateAdCompletion(input: {
  startedAtMs: number;
  nowMs: number;
  requiredSeconds: number;
  dailyCompletedViews: number;
  dailyAdLimit: number;
  campaignCompletedViews: number;
  campaignMaxImpressions: number;
  campaignRewardPaisa: number;
  campaignRemainingBudgetPaisa: number;
}) {
  if (input.nowMs - input.startedAtMs < input.requiredSeconds * 1000) {
    return { eligible: false, reason: "The required watch duration has not elapsed." } as const;
  }
  if (input.dailyCompletedViews >= input.dailyAdLimit) {
    return { eligible: false, reason: "The daily advertisement limit has been reached." } as const;
  }
  if (input.campaignCompletedViews >= input.campaignMaxImpressions) {
    return { eligible: false, reason: "This campaign has reached its impression limit." } as const;
  }
  if (input.campaignRemainingBudgetPaisa < input.campaignRewardPaisa) {
    return { eligible: false, reason: "This campaign does not have sufficient reward budget." } as const;
  }
  return { eligible: true, reason: null } as const;
}

export function evaluateVideoCompletion(input: {
  startedAtMs: number;
  nowMs: number;
  requiredSeconds: number;
  maxProgressSeconds: number;
  dailyClaims: number;
  dailyRewardLimit: number;
  belongsToActivePackage: boolean;
}) {
  if (input.dailyClaims >= input.dailyRewardLimit) return { eligible: false, reason: "Reward already claimed for this video today." } as const;
  if (!input.belongsToActivePackage) return { eligible: false, reason: "This video is not available for your membership." } as const;
  if (input.maxProgressSeconds < input.requiredSeconds - 2) return { eligible: false, reason: "The video has not reached a validated completion point." } as const;
  if (input.nowMs - input.startedAtMs < (input.requiredSeconds - 2) * 1000) return { eligible: false, reason: "The required playback duration has not elapsed." } as const;
  return { eligible: true, reason: null } as const;
}

export function getPlatformDayWindow(nowMs: number, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs));
    const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const year = value("year"); const month = value("month"); const day = value("day");
    const dateAtZoneMidnight = (y: number, m: number, d: number) => {
      const candidate = Date.UTC(y, m - 1, d);
      const offsetParts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(candidate));
      const offset = (type: string) => Number(offsetParts.find(part => part.type === type)?.value);
      return new Date(candidate - (Date.UTC(offset("year"), offset("month") - 1, offset("day"), offset("hour"), offset("minute"), offset("second")) - candidate));
    };
    const start = dateAtZoneMidnight(year, month, day);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const end = dateAtZoneMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
    return { dayKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, start, end, completedDay: new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`) };
  } catch {
    return getPlatformDayWindow(nowMs, "Asia/Karachi");
  }
}
