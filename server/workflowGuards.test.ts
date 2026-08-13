import { describe, expect, it } from "vitest";
import { assertPendingPaymentDecision, assertVideoRewardNotClaimed, assertVideoSessionAuthorization } from "./workflowGuards";

describe("payment and video workflow guards", () => {
  it("makes payment approval and rejection decisions idempotent", () => {
    expect(() => assertPendingPaymentDecision("pending")).not.toThrow();
    expect(() => assertPendingPaymentDecision("approved")).toThrow("no longer pending");
    expect(() => assertPendingPaymentDecision("rejected")).toThrow("no longer pending");
  });

  it("rejects unauthorized or resolved video completion attempts", () => {
    expect(() => assertVideoSessionAuthorization({ sessionUserId: 4, requesterUserId: 4, sessionStatus: "started" })).not.toThrow();
    expect(() => assertVideoSessionAuthorization({ sessionUserId: 4, requesterUserId: 7, sessionStatus: "started" })).toThrow("does not belong");
    expect(() => assertVideoSessionAuthorization({ sessionUserId: 4, requesterUserId: 4, sessionStatus: "completed" })).toThrow("already been resolved");
    expect(() => assertVideoRewardNotClaimed(true)).toThrow("already claimed");
  });
});
