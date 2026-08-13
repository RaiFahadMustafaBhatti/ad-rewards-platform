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
  if (amountPaisa < minimumWithdrawalPaisa) {
    throw new Error("The requested amount is below the minimum withdrawal.");
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
