import { describe, expect, it } from "vitest";
import { buildRewardVideoUpdateValues } from "./db";

describe("reward video persistence values", () => {
  it("persists a package reassignment and explicit display order through the data-layer update contract", () => {
    const values = buildRewardVideoUpdateValues({ adminUserId: 9, packageId: 3, title: "Reassigned video", platform: "tiktok", youtubeUrl: "https://www.tiktok.com/@creator/video/1234567890123456789", youtubeVideoId: "1234567890123456789", rewardPaisa: 500, requiredDurationSeconds: 45, dailyRewardLimit: 1, verificationCode: "482731", sortOrder: 8, status: "enabled" }, { requiredDurationSeconds: 30 });
    expect(values).toMatchObject({ packageId: 3, platform: "tiktok", sortOrder: 8, requiredDurationSeconds: 45, dailyRewardLimit: 1, updatedByUserId: 9 });
    expect(values.verificationCodeHash).toBeTruthy();
    expect(values.verificationCodeHash).not.toContain("482731");
  });
});
