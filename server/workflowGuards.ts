export function assertPendingPaymentDecision(status: "pending" | "approved" | "rejected") {
  if (status !== "pending") throw new Error("This payment proof is no longer pending.");
}

export function assertVideoSessionAuthorization(input: { sessionUserId: number; requesterUserId: number; sessionStatus: "started" | "interrupted" | "completed" | "rejected" | "expired" }) {
  if (input.sessionUserId !== input.requesterUserId) throw new Error("This video session does not belong to your account.");
  if (input.sessionStatus !== "started") throw new Error("This video session has already been resolved.");
}

export function assertVideoRewardNotClaimed(priorCompletion: boolean) {
  if (priorCompletion) throw new Error("Reward already claimed for this video.");
}
