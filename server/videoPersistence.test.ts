import { describe, expect, it } from "vitest";
import { assertEpisodeStartEligibility, buildRewardVideoUpdateValues, DEFAULT_REWARD_VIDEO_DURATION_SECONDS, resolveCurrentEpisode } from "./db";

describe("reward video persistence values", () => {
  it("persists a package reassignment and explicit display order through the data-layer update contract", () => {
    const values = buildRewardVideoUpdateValues({ adminUserId: 9, packageId: 3, title: "Reassigned video", platform: "tiktok", youtubeUrl: "https://www.tiktok.com/@creator/video/1234567890123456789", youtubeVideoId: "1234567890123456789", rewardPaisa: 500, requiredDurationSeconds: 45, dailyRewardLimit: 1, verificationCode: "482731", sortOrder: 8, episodeNumber: 3, status: "enabled" }, { requiredDurationSeconds: 30 });
    expect(values).toMatchObject({ packageId: 3, platform: "tiktok", sortOrder: 8, episodeNumber: 3, requiredDurationSeconds: 45, dailyRewardLimit: 1, updatedByUserId: 9 });
    expect(values.verificationCodeHash).toBeTruthy();
    expect(values.verificationCodeHash).not.toContain("482731");
  });

  it("keeps the existing ten-second watch experience as the creation default", () => {
    expect(DEFAULT_REWARD_VIDEO_DURATION_SECONDS).toBe(10);
  });
});

describe("episode sequencing", () => {
  it("resolves the lowest uncompleted episode, ignoring non-sequence videos", () => {
    expect(resolveCurrentEpisode([1, 2, 3], [])).toBe(1);
    expect(resolveCurrentEpisode([1, 2, 3], [1])).toBe(2);
    expect(resolveCurrentEpisode([1, 2, 3], [1, 2, 3])).toBe(null);
    expect(resolveCurrentEpisode([0, 1, 2], [1])).toBe(2);
    expect(resolveCurrentEpisode([2, 1, 3], [1])).toBe(2);
    expect(resolveCurrentEpisode([], [])).toBe(null);
    expect(resolveCurrentEpisode([0], [])).toBe(null);
  });

  it("permits starting only the current episode and enforces one episode per day", () => {
    const open = { videoEpisodeNumber: 2, currentEpisodeNumber: 2, claimedAnyEpisodeToday: false };
    expect(() => assertEpisodeStartEligibility(open)).not.toThrow();
    expect(() => assertEpisodeStartEligibility({ ...open, videoEpisodeNumber: 3 })).toThrow("not unlocked yet");
    expect(() => assertEpisodeStartEligibility({ ...open, currentEpisodeNumber: null })).toThrow("completed all available");
    expect(() => assertEpisodeStartEligibility({ ...open, claimedAnyEpisodeToday: true })).toThrow("unlocks tomorrow");
    expect(() => assertEpisodeStartEligibility({ ...open, videoEpisodeNumber: 0 })).toThrow("not part of the episode sequence");
  });
});
