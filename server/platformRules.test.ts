import { describe, expect, it } from "vitest";
import {
  calculateWithdrawalQuote,
  evaluateAdCompletion,
  isValidPakistanMobile,
  maskAccountNumber,
  validatePaymentScreenshot,
} from "./platformRules";

describe("platform financial and fraud rules", () => {
  it("quotes a withdrawal only when the minimum and fee rules are met", () => {
    expect(calculateWithdrawalQuote(5_000, 2_000, 150)).toEqual({
      amountPaisa: 5_000,
      feePaisa: 150,
      netAmountPaisa: 4_850,
    });
    expect(() => calculateWithdrawalQuote(1_999, 2_000, 150)).toThrow("minimum withdrawal");
    expect(() => calculateWithdrawalQuote(150, 100, 150)).toThrow("must exceed");
  });

  it("validates and masks Pakistan mobile and payout account fields", () => {
    expect(isValidPakistanMobile("03001234567")).toBe(true);
    expect(isValidPakistanMobile("+923001234567")).toBe(true);
    expect(isValidPakistanMobile("0312345678")).toBe(false);
    expect(maskAccountNumber("03001234567")).toBe("•••••••4567");
  });

  it("rejects a campaign completion before the server-side rules allow it", () => {
    const baseInput = {
      startedAtMs: 1_000,
      nowMs: 16_000,
      requiredSeconds: 15,
      dailyCompletedViews: 1,
      dailyAdLimit: 10,
      campaignCompletedViews: 3,
      campaignMaxImpressions: 100,
      campaignRewardPaisa: 5_000,
      campaignRemainingBudgetPaisa: 20_000,
    };
    expect(evaluateAdCompletion(baseInput)).toEqual({ eligible: true, reason: null });
    expect(evaluateAdCompletion({ ...baseInput, nowMs: 15_999 }).eligible).toBe(false);
    expect(evaluateAdCompletion({ ...baseInput, campaignRemainingBudgetPaisa: 4_999 }).eligible).toBe(false);
  });

  it("allows only image payment proofs under the configured size cap", () => {
    expect(() => validatePaymentScreenshot({ name: "proof.pdf", type: "application/pdf", bytes: 200 })).toThrow();
    expect(() => validatePaymentScreenshot({ name: "proof.png", type: "image/png", bytes: 6 * 1024 * 1024 })).toThrow();
    expect(() => validatePaymentScreenshot({ name: "proof.webp", type: "image/webp", bytes: 1_024 })).not.toThrow();
  });
});
