import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { isFirebaseConfigured, verifyFirebaseIdToken } from "../firebase";
import { getSessionCookieOptions } from "./cookies";
import { createSessionToken } from "./session";

/**
 * Member sign-in via Firebase Authentication (Google provider).
 *
 * The client signs in with the Firebase client SDK (Google popup), then POSTs
 * the Firebase ID token here. The server verifies the token with the Admin
 * SDK, upserts the member record, and sets the first-party `app_session_id`
 * HTTP-only cookie via a stateless HS256 session token.
 */
export function registerFirebaseAuthRoutes(app: Express) {
  app.post("/api/auth/firebase", async (req: Request, res: Response) => {
    const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
    if (!idToken) {
      res.status(400).json({ error: "idToken is required" });
      return;
    }

    if (!isFirebaseConfigured()) {
      res.status(503).json({ error: "Member sign-in is not configured yet. Please try again later." });
      return;
    }

    try {
      const verified = await verifyFirebaseIdToken(idToken);
      if (!verified) {
        res.status(401).json({ error: "The sign-in token is invalid." });
        return;
      }

      const openId = `firebase:${verified.uid}`;
      await db.upsertUser({
        openId,
        name: verified.name ?? null,
        email: verified.email ?? null,
        loginMethod: "firebase_google",
        lastSignedIn: new Date(),
      });

      const user = await db.getUserByOpenId(openId);
      if (!user) {
        res.status(500).json({ error: "The member account could not be prepared." });
        return;
      }
      if (user.accountStatus !== "active") {
        res.status(403).json({ error: "This account is not active. Please contact support." });
        return;
      }

      const sessionToken = await createSessionToken(user.openId, {
        name: user.name ?? "",
        expiresInMs: ONE_YEAR_MS,
      });
      res.cookie(COOKIE_NAME, sessionToken, {
        ...getSessionCookieOptions(req),
        maxAge: ONE_YEAR_MS,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("[FirebaseAuth] Token exchange failed", error);
      res.status(401).json({ error: "The sign-in token could not be verified. Please try again." });
    }
  });
}
