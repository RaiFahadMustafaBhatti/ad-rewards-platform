// First-party session tokens (HS256 JWT, signed with JWT_SECRET).
//
// Replaces the Manus platform session service. The client receives this
// token either as the `app_session_id` cookie (member Google sign-in via
// /api/auth/firebase, local admin login) or as an Authorization Bearer token.
// Sessions are stateless, so they work unchanged on Vercel serverless
// functions.

import { ONE_YEAR_MS } from "@shared/const";
import { SignJWT, jwtVerify } from "jose";

export interface SessionClaims {
  openId: string;
  name: string;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET ?? "");
}

export async function createSessionToken(
  openId: string,
  options: { expiresInMs?: number; name?: string } = {},
): Promise<string> {
  const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
  return new SignJWT({ openId, name: options.name ?? "" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor((Date.now() + expiresInMs) / 1000))
    .sign(getSecret());
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (typeof payload.openId !== "string" || !payload.openId) return null;
    return {
      openId: payload.openId,
      name: typeof payload.name === "string" ? payload.name : "",
    };
  } catch {
    return null;
  }
}
