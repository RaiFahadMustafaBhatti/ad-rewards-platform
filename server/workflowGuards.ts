export function assertPendingPaymentDecision(status: "pending" | "approved" | "rejected") {
  if (status !== "pending") throw new Error("This payment proof is no longer pending.");
}

export function assertVideoSessionAuthorization(input: { sessionUserId: number; requesterUserId: number; sessionStatus: "started" | "interrupted" | "eligible" | "claimed" | "rejected" | "expired" }) {
  if (input.sessionUserId !== input.requesterUserId) throw new Error("This video session does not belong to your account.");
  if (input.sessionStatus !== "eligible") throw new Error("This video session is not eligible to claim a reward.");
}

export function assertVideoRewardNotClaimed(priorCompletion: boolean) {
  if (priorCompletion) throw new Error("Reward already claimed for this video.");
}
