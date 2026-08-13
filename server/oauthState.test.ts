import { describe, expect, it } from "vitest";
import { decodeOAuthState, encodeOAuthState } from "@shared/const";

describe("OAuth return destinations", () => {
  it("retains the selected membership destination through a signed-in callback state", () => {
    const state = encodeOAuthState({ redirectUri: "https://example.test/api/oauth/callback", nonce: "nonce", returnTo: "/dashboard/membership?package=2" });
    expect(decodeOAuthState(state)).toMatchObject({ nonce: "nonce", returnTo: "/dashboard/membership?package=2" });
  });

  it("does not fabricate a return destination from malformed state", () => {
    expect(decodeOAuthState("not-base64").returnTo).toBeUndefined();
  });
});
