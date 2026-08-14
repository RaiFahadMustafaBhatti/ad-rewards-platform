import { describe, expect, it } from "vitest";
import { buildPackageRulesUpdateValues, isCampaignEligibleForPackage, normalizePersistentSettingValue } from "./db";

describe("persistent administration contracts", () => {
  it("retains every saved package rule in the backend update payload", () => {
    expect(buildPackageRulesUpdateValues({ pricePaisa: 500_000, rewardPerEligibleAdPaisa: 5_000, dailyAdLimit: 30, durationDays: 45, status: "active" })).toEqual({ pricePaisa: 500_000, rewardPerEligibleAdPaisa: 5_000, dailyAdLimit: 30, durationDays: 45, status: "active" });
  });

  it("normalizes a persisted administrator setting and applies package-scoped campaign visibility", () => {
    expect(normalizePersistentSettingValue("  ACTIVE  ")).toBe("ACTIVE");
    expect(isCampaignEligibleForPackage(null, 2)).toBe(true);
    expect(isCampaignEligibleForPackage(2, 2)).toBe(true);
    expect(isCampaignEligibleForPackage(3, 2)).toBe(false);
  });
});
