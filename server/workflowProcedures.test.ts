import { vi, describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  reviewPaymentProof: vi.fn(),
  completeVideoWatchSession: vi.fn(),
}));

vi.mock("./db", async () => ({
  ...(await vi.importActual<typeof import("./db")>("./db")),
  reviewPaymentProof: mocks.reviewPaymentProof,
  completeVideoWatchSession: mocks.completeVideoWatchSession,
}));

import { appRouter } from "./routers";

function context(role: "user" | "admin"): TrpcContext {
  return { user: { id: role === "admin" ? 9 : 4, openId: `test-${role}`, name: "Test", email: "test@example.com", loginMethod: "test", role, accountStatus: "active", phone: null, referralCode: null, referredByUserId: null, lastKnownDeviceHash: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() }, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("workflow procedures", () => {
  it("passes recorded admin identity to payment review and propagates an idempotent duplicate decision rejection", async () => {
    mocks.reviewPaymentProof.mockResolvedValueOnce({ status: "approved" }).mockRejectedValueOnce(new Error("This payment proof is no longer pending."));
    const caller = appRouter.createCaller(context("admin"));
    await expect(caller.admin.reviewPayment({ paymentProofId: 11, action: "approve" })).resolves.toEqual({ status: "approved" });
    await expect(caller.admin.reviewPayment({ paymentProofId: 11, action: "approve" })).rejects.toThrow("no longer pending");
    expect(mocks.reviewPaymentProof).toHaveBeenNthCalledWith(1, { paymentProofId: 11, action: "approve", adminUserId: 9 });
  });

  it("binds completion to the authenticated member and surfaces unauthorized session failures", async () => {
    mocks.completeVideoWatchSession.mockRejectedValueOnce(new Error("This video session does not belong to your account."));
    const caller = appRouter.createCaller(context("user"));
    await expect(caller.videos.complete({ sessionToken: "c6a023cc-6eef-4a05-981a-7b4b354fc169" })).rejects.toThrow("does not belong");
    expect(mocks.completeVideoWatchSession).toHaveBeenCalledWith({ userId: 4, sessionToken: "c6a023cc-6eef-4a05-981a-7b4b354fc169" });
  });
});
