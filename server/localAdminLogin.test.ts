import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  getUserByEmail: vi.fn(),
  getUserByOpenId: vi.fn(),
  upsertUser: vi.fn(),
  createSessionToken: vi.fn(),
}));

vi.mock("./db", async () => ({ ...(await vi.importActual<typeof import("./db")>("./db")), getUserByEmail: mocks.getUserByEmail, getUserByOpenId: mocks.getUserByOpenId, upsertUser: mocks.upsertUser }));
vi.mock("./_core/sdk", () => ({ sdk: { createSessionToken: mocks.createSessionToken } }));

import { appRouter } from "./routers";

describe("auth.localAdminLogin", () => {
  it("accepts the configured administrator credentials, refreshes the active admin identity, and writes a session cookie", async () => {
    const admin = { id: 1, openId: "admin-open-id", email: process.env.ADMIN_EMAIL!, name: "FMB Earning Hub Administrator", loginMethod: "local_admin", role: "admin" as const, accountStatus: "active" as const, phone: null, referralCode: null, referredByUserId: null, lastKnownDeviceHash: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
    mocks.getUserByEmail.mockResolvedValue(admin);
    mocks.createSessionToken.mockResolvedValue("signed-admin-session");
    const cookies: Array<{ name: string; value: string }> = [];
    const ctx = { user: null, req: { protocol: "https", headers: {} }, res: { cookie: (name: string, value: string) => cookies.push({ name, value }) } } as unknown as TrpcContext;
    const caller = appRouter.createCaller(ctx);
    await expect(caller.auth.localAdminLogin({ email: process.env.ADMIN_EMAIL!, password: process.env.ADMIN_PASSWORD! })).resolves.toEqual({ success: true });
    expect(mocks.getUserByEmail).toHaveBeenCalledWith(process.env.ADMIN_EMAIL!);
    expect(mocks.createSessionToken).toHaveBeenCalledWith(admin.openId, expect.objectContaining({ expiresInMs: 8 * 60 * 60 * 1_000 }));
    expect(cookies).toEqual([{ name: "app_session_id", value: "signed-admin-session" }]);
  });
});
