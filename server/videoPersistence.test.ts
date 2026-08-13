import { describe, expect, it } from "vitest";
import { buildRewardVideoUpdateValues } from "./db";

describe("reward video persistence values", () => {
  it("persists a package reassignment and explicit display order through the data-layer update contract", () => {
    const values = buildRewardVideoUpdateValues({ adminUserId: 9, packageId: 3, title: "Reassigned video", youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", youtubeVideoId: "dQw4w9WgXcQ", rewardPaisa: 500, requiredDurationSeconds: 45, sortOrder: 8, status: "enabled" }, { requiredDurationSeconds: 30 });
    expect(values).toMatchObject({ packageId: 3, sortOrder: 8, requiredDurationSeconds: 45, updatedByUserId: 9 });
  });
});
