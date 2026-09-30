import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { parse as parseCookieHeader } from "cookie";
import type { User } from "../../drizzle/schema";
import { COOKIE_NAME } from "@shared/const";
import { getUserByOpenId } from "../db";
import { verifySessionToken } from "./session";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

function extractSessionToken(req: CreateExpressContextOptions["req"]): string | null {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  const cookieToken = cookies[COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim() || null;
  return null;
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    const token = extractSessionToken(opts.req);
    const claims = await verifySessionToken(token);
    if (claims) {
      user = (await getUserByOpenId(claims.openId)) ?? null;
    }
  } catch (error) {
    // Authentication is optional for public procedures.
    console.warn("[Auth] Session verification failed:", error);
    user = null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
