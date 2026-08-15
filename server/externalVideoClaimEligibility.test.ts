import { describe, expect, it } from "vitest";
import { assertExternalVideoClaimEligibility } from "./db";

const eligible = { sessionUserId: 7, requesterUserId: 7, sessionStatus: "code_verified", verificationStatus: "passed", rewardStatus: "pending", dailyClaims: 0, dailyRewardLimit: 1 };

describe("external video reward claim eligibility", () => {
  it("blocks a different user from claiming another member's externally verified session", () => {
    expect(() => assertExternalVideoClaimEligibility({ ...eligible, requesterUserId: 8 })).toThrow("does not belong");
  });

  it("blocks repeat claims from an already rewarded external session", () => {
    expect(() => assertExternalVideoClaimEligibility({ ...eligible, sessionStatus: "claimed", rewardStatus: "claimed" })).toThrow("already been rewarded");
  });

  it("enforces the one-per-video daily reward limit after a successful external verification", () => {
    expect(() => assertExternalVideoClaimEligibility({ ...eligible, dailyClaims: 1, dailyRewardLimit: 1 })).toThrow("already claimed");
    expect(() => assertExternalVideoClaimEligibility(eligible)).not.toThrow();
  });
});
