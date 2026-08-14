import { describe, expect, it } from "vitest";
import { assertVideoStartEligibility, canBeginAssignedVideo, startVideoWatchSession } from "./db";

describe("assigned video session eligibility", () => {
  it("permits an active member account to begin an assigned package video while retaining review and suspension protection", () => {
    expect(canBeginAssignedVideo("active")).toBe(true);
    expect(canBeginAssignedVideo("review")).toBe(false);
    expect(canBeginAssignedVideo("suspended")).toBe(false);
  });

  it("allows the real start-workflow conditions only for an active member with an active package and enabled assigned video", () => {
    const allowed = { accountStatus: "active" as const, hasActiveMembership: true, isVideoEnabled: true, isAssignedToMemberPackage: true };
    expect(() => assertVideoStartEligibility(allowed)).not.toThrow();
    expect(() => assertVideoStartEligibility({ ...allowed, accountStatus: "review" })).toThrow("under review");
    expect(() => assertVideoStartEligibility({ ...allowed, accountStatus: "suspended" })).toThrow("suspended");
    expect(() => assertVideoStartEligibility({ ...allowed, hasActiveMembership: false })).toThrow("active membership");
    expect(() => assertVideoStartEligibility({ ...allowed, isAssignedToMemberPackage: false })).toThrow("not available");
  });

  it("exercises startVideoWatchSession for an active assigned member and preserves review and suspension rejections", async () => {
    const created: unknown[] = [];
    const base = { membership: { membership: { id: 31 }, package: { id: 8 } }, video: { id: 55, packageId: 8, status: "enabled" as const, requiredDurationSeconds: 45 }, sessionToken: "test-session", createSession: (value: unknown) => { created.push(value); } };
    await expect(startVideoWatchSession({ userId: 7, videoId: 55 }, { ...base, user: { accountStatus: "active" } })).resolves.toMatchObject({ sessionToken: "test-session", requiredDurationSeconds: 45, resumed: false });
    expect(created).toEqual([{ sessionToken: "test-session", userId: 7, videoId: 55, membershipId: 31, requiredDurationSeconds: 45 }]);
    await expect(startVideoWatchSession({ userId: 7, videoId: 55 }, { ...base, user: { accountStatus: "review" } })).rejects.toThrow("under review");
    await expect(startVideoWatchSession({ userId: 7, videoId: 55 }, { ...base, user: { accountStatus: "suspended" } })).rejects.toThrow("suspended");
  });
});
