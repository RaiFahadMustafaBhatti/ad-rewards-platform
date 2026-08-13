import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createContext(role: "user" | "admin"): TrpcContext {
  return {
    user: {
      id: 42,
      openId: `test-${role}`,
      name: "Test Account",
      email: "test@example.com",
      loginMethod: "manus",
      role,
      accountStatus: "active",
      phone: null,
      referralCode: null,
      referredByUserId: null,
      lastKnownDeviceHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("administrator authorization", () => {
  it("rejects a member before invoking administrator-only operations", async () => {
    const caller = appRouter.createCaller(createContext("user"));
    await expect(caller.admin.summary()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
