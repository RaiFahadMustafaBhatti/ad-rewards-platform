export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Start the member Google sign-in with Firebase Authentication.
//
// It has SIDE EFFECTS - it opens the Google account chooser popup, exchanges
// the Firebase ID token for the first-party app session cookie via
// POST /api/auth/firebase, and navigates - so call it from an event handler
// or effect at the moment you want to sign in, e.g.
// `onClick={() => startLogin()}`. Do NOT call it during render.
export const startLogin = async (returnTo = "/dashboard") => {
  const { signInWithPopup } = await import("firebase/auth");
  const { getFirebaseAuthClient, getGoogleProvider } = await import("@/lib/firebase");

  const credential = await signInWithPopup(getFirebaseAuthClient(), getGoogleProvider());
  const idToken = await credential.user.getIdToken();

  const res = await fetch("/api/auth/firebase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Sign-in failed. Please try again.");
  }

  // Mirror the session cookie into sessionStorage for the Safari ITP /
  // WebView fallback (see main.tsx): the tRPC client forwards it as a
  // Bearer token when third-party cookies are blocked.
  try {
    const cookies = document.cookie.split(";");
    sessionStorage.setItem("fmb-session", cookies.map((c) => c.trim()).join("; "));
  } catch {
    // sessionStorage unavailable
  }

  const destination =
    returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/dashboard";
  if (window.location.pathname === destination) {
    window.location.reload();
  } else {
    window.location.href = destination;
  }
};
