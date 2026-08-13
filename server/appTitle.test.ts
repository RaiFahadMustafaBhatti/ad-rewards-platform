import { describe, expect, it } from "vitest";
import { isDesignatedAdminEmail } from "./db";

describe("managed application title", () => {
  it("uses the configured FMB Earning Hub title", () => {
    expect(process.env.VITE_APP_TITLE).toBe("FMB Earning Hub");
  });

  it("exposes the designated administrator email only to server-side configuration", () => {
    expect(process.env.ADMIN_EMAIL).toBe("pimplesboy2@gmail.com");
  });

  it("recognizes only the configured administrator email without regard to casing or whitespace", () => {
    expect(isDesignatedAdminEmail(" PIMPLESBOY2@gmail.com ")).toBe(true);
    expect(isDesignatedAdminEmail("someone@example.com")).toBe(false);
  });

  it("provides a non-empty server-side administrator password secret", () => {
    expect(process.env.ADMIN_PASSWORD).toBeTruthy();
  });
});
