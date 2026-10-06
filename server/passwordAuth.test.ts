import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  verifyMemberPasswordLogin: vi.fn(),
  signupMemberWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPasswordWithToken: vi.fn(),
  changeMemberPassword: vi.fn(),
  deleteMemberAccount: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByOpenId: vi.fn(),
  upsertUser: vi.fn(),
  createSessionToken: vi.fn(),
}));

vi.mock("./db", async () => ({
  ...(await vi.importActual<typeof import("./db")>("./db")),
  verifyMemberPasswordLogin: mocks.verifyMemberPasswordLogin,
  signupMemberWithPassword: mocks.signupMemberWithPassword,
  requestPasswordReset: mocks.requestPasswordReset,
  resetPasswordWithToken: mocks.resetPasswordWithToken,
  changeMemberPassword: mocks.changeMemberPassword,
  deleteMemberAccount: mocks.deleteMemberAccount,
  getUserByEmail: mocks.getUserByEmail,
  getUserByOpenId: mocks.getUserByOpenId,
  upsertUser: mocks.upsertUser,
}));
vi.mock("./_core/session", () => ({ createSessionToken: mocks.createSessionToken }));

import { appRouter } from "./routers";

function makeCtx(user: unknown = null) {
  const cookies: Array<{ name: string; value: string }> = [];
  const ctx = {
    user,
    req: { protocol: "https", headers: {} },
    res: { cookie: (name: string, value: string) => cookies.push({ name, value }) },
  } as unknown as TrpcContext;
  return { ctx, cookies };
}

const adminRecord = {
  id: 1,
  openId: "local-admin:admin@example.com",
  email: "admin@example.com",
  name: "FMB Earning Hub Administrator",
  loginMethod: "local_admin",
  passwordHash: null,
  role: "admin",
  accountStatus: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAIL = "admin@example.com";
  process.env.ADMIN_PASSWORD = "admin-secret";
});

describe("auth.passwordLogin", () => {
  it("routes the administrator email to the admin panel with an 8-hour session", async () => {
    mocks.getUserByEmail.mockResolvedValue(adminRecord);
    mocks.createSessionToken.mockResolvedValue("signed-admin-session");
    const { ctx, cookies } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.passwordLogin({ email: "admin@example.com", password: "admin-secret" }),
    ).resolves.toEqual({ role: "admin" });
    expect(mocks.verifyMemberPasswordLogin).not.toHaveBeenCalled();
    expect(mocks.createSessionToken).toHaveBeenCalledWith(
      "local-admin:admin@example.com",
      expect.objectContaining({ expiresInMs: 8 * 60 * 60 * 1_000 }),
    );
    expect(cookies).toEqual([{ name: "app_session_id", value: "signed-admin-session" }]);
  });

  it("rejects a wrong administrator password without revealing the account", async () => {
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.passwordLogin({ email: "admin@example.com", password: "wrong" }),
    ).rejects.toThrow(/Invalid email or password/);
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it("signs in a member and returns the member role", async () => {
    mocks.verifyMemberPasswordLogin.mockResolvedValue({
      id: 7,
      openId: "password:member@example.com",
      name: "Member",
      email: "member@example.com",
      passwordHash: null,
    });
    mocks.createSessionToken.mockResolvedValue("signed-member-session");
    const { ctx, cookies } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.passwordLogin({ email: "member@example.com", password: "member-pass-1" }),
    ).resolves.toEqual({ role: "member" });
    expect(mocks.verifyMemberPasswordLogin).toHaveBeenCalledWith({ email: "member@example.com", password: "member-pass-1" });
    expect(mocks.createSessionToken).toHaveBeenCalledWith(
      "password:member@example.com",
      expect.objectContaining({ expiresInMs: 365 * 24 * 60 * 60 * 1000 }),
    );
    expect(cookies).toEqual([{ name: "app_session_id", value: "signed-member-session" }]);
  });

  it("surfaces invalid member credentials generically", async () => {
    mocks.verifyMemberPasswordLogin.mockRejectedValue(new Error("Invalid email or password."));
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.passwordLogin({ email: "nobody@example.com", password: "whatever-123" }),
    ).rejects.toThrow(/Invalid email or password/);
  });
});

describe("auth.passwordSignup", () => {
  it("creates the account in review status", async () => {
    mocks.signupMemberWithPassword.mockResolvedValue({ status: "review" });
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.passwordSignup({ name: "New Member", email: "new@gmail.com", password: "new-pass-123", phone: "03001234567" }),
    ).resolves.toEqual({ status: "review" });
  });

  it("rejects short passwords at the boundary", async () => {
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.passwordSignup({ name: "New Member", email: "new@gmail.com", password: "short", phone: "03001234567" }),
    ).rejects.toThrow();
    expect(mocks.signupMemberWithPassword).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone number at the boundary", async () => {
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.passwordSignup({ name: "New Member", email: "new@gmail.com", password: "new-pass-123", phone: "123" }),
    ).rejects.toThrow();
    expect(mocks.signupMemberWithPassword).not.toHaveBeenCalled();
  });

  it("rejects non-Gmail addresses at the boundary", async () => {
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.passwordSignup({ name: "New Member", email: "new@yahoo.com", password: "new-pass-123", phone: "03001234567" }),
    ).rejects.toThrow(/Gmail/);
    expect(mocks.signupMemberWithPassword).not.toHaveBeenCalled();
  });
});

describe("auth.requestPasswordReset / auth.resetPassword", () => {
  it("returns success for reset requests", async () => {
    mocks.requestPasswordReset.mockResolvedValue({ success: true });
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.auth.requestPasswordReset({ email: "member@example.com" })).resolves.toEqual({ success: true });
  });

  it("consumes a reset token", async () => {
    mocks.resetPasswordWithToken.mockResolvedValue({ success: true });
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.resetPassword({ token: "a".repeat(64), newPassword: "brand-new-123" }),
    ).resolves.toEqual({ success: true });
    expect(mocks.resetPasswordWithToken).toHaveBeenCalledWith({ token: "a".repeat(64), newPassword: "brand-new-123" });
  });
});

describe("profile.deleteAccount", () => {
  it("deletes the authenticated member and clears the session cookie", async () => {
    mocks.deleteMemberAccount.mockResolvedValue({ success: true, deletedDocuments: 5 });
    const cleared: Array<{ name: string }> = [];
    const ctx = {
      user: { id: 7 },
      req: { protocol: "https", headers: {} },
      res: {
        cookie: () => {},
        clearCookie: (name: string) => cleared.push({ name }),
      },
    } as unknown as TrpcContext;
    const caller = appRouter.createCaller(ctx);
    await expect(caller.profile.deleteAccount()).resolves.toEqual({ success: true, deletedDocuments: 5 });
    expect(mocks.deleteMemberAccount).toHaveBeenCalledWith(7);
    expect(cleared).toEqual([{ name: "app_session_id" }]);
  });

  it("requires authentication", async () => {
    const { ctx } = makeCtx(null);
    const caller = appRouter.createCaller(ctx);
    await expect(caller.profile.deleteAccount()).rejects.toThrow();
    expect(mocks.deleteMemberAccount).not.toHaveBeenCalled();
  });
});

describe("profile.changePassword", () => {
  it("changes the password for the authenticated member", async () => {
    mocks.changeMemberPassword.mockResolvedValue({ success: true });
    const { ctx } = makeCtx({ id: 7 });
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.profile.changePassword({ currentPassword: "old-pass-123", newPassword: "new-pass-123" }),
    ).resolves.toEqual({ success: true });
    expect(mocks.changeMemberPassword).toHaveBeenCalledWith({ userId: 7, currentPassword: "old-pass-123", newPassword: "new-pass-123" });
  });
});
