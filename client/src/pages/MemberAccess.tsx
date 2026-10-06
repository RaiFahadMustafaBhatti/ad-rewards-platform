import { startLogin } from "@/const";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { KeyRound, Loader2, LogIn, ShieldCheck, UserPlus, ArrowLeft, BadgeCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type Mode = "signin" | "signup" | "forgot";

const inputClass = "h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-[#20bdb2]";

export default function MemberAccess() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<Mode>("signin");
  const selectedPackage = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("package");
  const returnTo = selectedPackage ? `/dashboard/membership?package=${encodeURIComponent(selectedPackage)}` : "/dashboard";

  // Sign in state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Sign up state
  const [name, setName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPhone, setSignupPhone] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [signupDone, setSignupDone] = useState(false);

  // Prefill a friend's referral code from an invite link (?ref=CODE).
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref")?.trim().toUpperCase() ?? "";
      if (ref) {
        setReferralCode(ref);
        sessionStorage.setItem("fmb-pending-ref", ref);
      }
    } catch {}
  }, []);
  // Forgot state
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotDone, setForgotDone] = useState(false);

  const login = trpc.auth.passwordLogin.useMutation();
  const startVerification = trpc.auth.startEmailVerification.useMutation();
  const verifyOtp = trpc.auth.verifyEmailOtp.useMutation();
  const resendOtp = trpc.auth.resendEmailOtp.useMutation();
  const requestReset = trpc.auth.requestPasswordReset.useMutation();
  const resetWithOtp = trpc.auth.resetPasswordWithOtp.useMutation();
  const [otpStep, setOtpStep] = useState<"details" | "code">("details");
  const [verificationId, setVerificationId] = useState<number | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [forgotStep, setForgotStep] = useState<"email" | "code">("email");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotNewPassword, setForgotNewPassword] = useState("");

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const result = await login.mutateAsync({ email, password });
      setPassword("");
      if (result.role === "admin") window.location.assign("/admin");
      else window.location.assign(returnTo);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign-in could not be completed.");
    }
  };

  const submitSignup = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const result = await startVerification.mutateAsync({ name, email: signupEmail, password: signupPassword, phone: signupPhone, referralCode: referralCode.trim() || undefined });
      setVerificationId(result.verificationId);
      setOtpStep("code");
      toast.success("A 6-digit verification code was sent to your email.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign-up could not be completed.");
    }
  };

  const submitOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (verificationId == null) return;
    try {
      await verifyOtp.mutateAsync({ verificationId, code: otpCode });
      try { sessionStorage.removeItem("fmb-pending-ref"); } catch {}
      setSignupPassword("");
      setOtpCode("");
      setSignupDone(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification failed.");
    }
  };

  const resendCode = async () => {
    if (verificationId == null) return;
    try {
      await resendOtp.mutateAsync({ verificationId });
      toast.success("A new code was sent to your email.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not resend the code.");
    }
  };

  const submitForgot = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await requestReset.mutateAsync({ email: forgotEmail });
      setForgotStep("code");
      toast.success("A 6-digit reset code was sent to your email.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the password reset.");
    }
  };

  const submitForgotCode = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await resetWithOtp.mutateAsync({ email: forgotEmail, code: forgotCode, newPassword: forgotNewPassword });
      setForgotCode("");
      setForgotNewPassword("");
      setForgotDone(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password reset failed.");
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setSignupDone(false);
    setForgotDone(false);
    setOtpStep("details");
    setForgotStep("email");
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f8fc] px-4 py-10">
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-[0_22px_60px_rgba(16,35,63,.12)] sm:p-9">
        <button onClick={() => setLocation("/")} className="flex items-center gap-2 text-left font-extrabold text-[#10233f]">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#10233f] text-sm font-black text-[#6ee7dc]">F</span>
          FMB Earning Hub
        </button>

        <div className="mt-10">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#e9fbf8] text-[#13897f]">
            {mode === "signup" ? <UserPlus size={23} /> : mode === "forgot" ? <KeyRound size={23} /> : <ShieldCheck size={23} />}
          </span>
          <p className="mt-5 text-xs font-extrabold uppercase tracking-[.18em] text-[#13897f]">
            {mode === "signup" ? "Create account" : mode === "forgot" ? "Password reset" : "Member workspace"}
          </p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-[-.04em] text-[#10233f]">
            {mode === "signup" ? "Sign up" : mode === "forgot" ? "Forgot password" : "Sign in"}
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {mode === "signup"
              ? "Create your member account with an email and password. New accounts are reviewed by the administrator before activation."
              : mode === "forgot"
                ? "Enter your account email and we will send you a link to set a new password."
                : selectedPackage
                  ? "After sign-in, your selected membership will be ready for payment verification."
                  : "Sign in with your email and password, or continue with Google. The administrator signs in here too."}
          </p>
        </div>

        {mode === "signin" && (
          <>
            <form onSubmit={submitLogin} className="mt-7 grid gap-4">
              <label className="grid gap-1.5 text-sm font-bold text-slate-700">
                Email
                <input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={inputClass} placeholder="you@example.com" />
              </label>
              <label className="grid gap-1.5 text-sm font-bold text-slate-700">
                Password
                <input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={inputClass} placeholder="Your password" />
              </label>
              <Button disabled={login.isPending} className="mt-1 h-11 rounded-xl bg-[#10233f] font-bold hover:bg-[#19375f]">
                {login.isPending ? <Loader2 className="animate-spin" size={17} /> : <><LogIn className="mr-2" size={17} />Sign in</>}
              </Button>
            </form>
            <button onClick={() => switchMode("forgot")} className="mt-3 text-sm font-bold text-[#13897f] hover:underline">
              Forgot password?
            </button>
            <div className="my-5 flex items-center gap-3 text-xs font-bold uppercase tracking-wider text-slate-400">
              <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
            </div>
            <Button
              variant="outline"
              onClick={() => startLogin(returnTo).catch((error: unknown) => { console.error("[Login] Google sign-in failed", error); alert(error instanceof Error ? error.message : "Sign-in failed. Please try again."); })}
              className="h-11 w-full rounded-xl border-slate-300 font-bold"
            >
              Continue with Google
            </Button>
            <p className="mt-6 text-center text-sm text-slate-600">
              New here?{" "}
              <button onClick={() => switchMode("signup")} className="font-bold text-[#13897f] hover:underline">
                Create an account
              </button>
            </p>
          </>
        )}

        {mode === "signup" && !signupDone && otpStep === "details" && (
          <>
          <form onSubmit={submitSignup} className="mt-7 grid gap-4">
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Full name
              <input required type="text" autoComplete="name" value={name} onChange={e => setName(e.target.value)} className={inputClass} placeholder="Your full name" />
            </label>
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Email
              <input required type="email" autoComplete="email" value={signupEmail} onChange={e => setSignupEmail(e.target.value)} className={inputClass} placeholder="you@gmail.com" />
              <span className="text-xs font-normal text-slate-500">Gmail address only</span>
            </label>
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Mobile number
              <input required type="tel" autoComplete="tel" value={signupPhone} onChange={e => setSignupPhone(e.target.value)} className={inputClass} placeholder="03XXXXXXXXX" />
            </label>
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Password
              <input required type="password" autoComplete="new-password" minLength={8} value={signupPassword} onChange={e => setSignupPassword(e.target.value)} className={inputClass} placeholder="At least 8 characters" />
            </label>
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Referral code <span className="font-normal text-slate-400">(optional)</span>
              <input type="text" autoComplete="off" value={referralCode} onChange={e => setReferralCode(e.target.value.toUpperCase())} className={`${inputClass} font-mono uppercase`} placeholder="Friend's invite code" />
            </label>
            <Button disabled={startVerification.isPending} className="mt-1 h-11 rounded-xl bg-[#10233f] font-bold hover:bg-[#19375f]">
              {startVerification.isPending ? <Loader2 className="animate-spin" size={17} /> : <><UserPlus className="mr-2" size={17} />Send verification code</>}
            </Button>
          </form>
          <div className="my-5 flex items-center gap-3 text-xs font-bold uppercase tracking-wider text-slate-400">
            <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
          </div>
          <Button
            variant="outline"
            onClick={() => startLogin(returnTo).catch((error: unknown) => { console.error("[Login] Google sign-in failed", error); alert(error instanceof Error ? error.message : "Sign-in failed. Please try again."); })}
            className="h-11 w-full rounded-xl border-slate-300 font-bold"
          >
            Continue with Google
          </Button>
          <p className="mt-6 text-center text-sm text-slate-600">
            Already have an account?{" "}
            <button onClick={() => switchMode("signin")} className="font-bold text-[#13897f] hover:underline">
              Sign in
            </button>
          </p>
          </>
        )}

        {mode === "signup" && !signupDone && otpStep === "code" && (
          <form onSubmit={submitOtp} className="mt-7 grid gap-4">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900">
              <p className="font-extrabold">Check your email.</p>
              <p className="mt-1">We sent a 6-digit verification code to <span className="font-bold">{signupEmail}</span>. It expires in 10 minutes.</p>
            </div>
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Verification code
              <input required type="text" inputMode="numeric" autoComplete="one-time-code" value={otpCode} onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className={`${inputClass} text-center font-mono text-2xl tracking-[.4em]`} placeholder="••••••" />
            </label>
            <Button disabled={verifyOtp.isPending} className="mt-1 h-11 rounded-xl bg-[#10233f] font-bold hover:bg-[#19375f]">
              {verifyOtp.isPending ? <Loader2 className="animate-spin" size={17} /> : <><BadgeCheck className="mr-2" size={17} />Verify & create account</>}
            </Button>
            <div className="flex items-center justify-between text-sm">
              <button type="button" onClick={() => setOtpStep("details")} className="font-bold text-slate-600 hover:underline">Back</button>
              <button type="button" disabled={resendOtp.isPending} onClick={resendCode} className="font-bold text-[#13897f] hover:underline disabled:opacity-50">Resend code</button>
            </div>
          </form>
        )}

        {mode === "signup" && signupDone && (
          <div className="mt-7 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm leading-6 text-emerald-900">
            <p className="font-extrabold">Account created.</p>
            <p className="mt-1">Your account is waiting for administrator approval. You will be able to sign in once it is approved.</p>
            <button onClick={() => switchMode("signin")} className="mt-3 font-bold text-[#13897f] hover:underline">
              Back to sign in
            </button>
          </div>
        )}

        {mode === "forgot" && !forgotDone && forgotStep === "email" && (
          <form onSubmit={submitForgot} className="mt-7 grid gap-4">
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Account email
              <input required type="email" autoComplete="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} className={inputClass} placeholder="you@gmail.com" />
            </label>
            <Button disabled={requestReset.isPending} className="mt-1 h-11 rounded-xl bg-[#10233f] font-bold hover:bg-[#19375f]">
              {requestReset.isPending ? <Loader2 className="animate-spin" size={17} /> : <><KeyRound className="mr-2" size={17} />Send verification code</>}
            </Button>
            <button type="button" onClick={() => switchMode("signin")} className="flex items-center justify-center gap-1 text-sm font-bold text-slate-600 hover:underline">
              <ArrowLeft size={15} /> Back to sign in
            </button>
          </form>
        )}

        {mode === "forgot" && !forgotDone && forgotStep === "code" && (
          <form onSubmit={submitForgotCode} className="mt-7 grid gap-4">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900">
              <p className="font-extrabold">Check your email.</p>
              <p className="mt-1">We sent a 6-digit reset code to <span className="font-bold">{forgotEmail}</span>. It expires in 10 minutes.</p>
            </div>
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Reset code
              <input required type="text" inputMode="numeric" autoComplete="one-time-code" value={forgotCode} onChange={e => setForgotCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className={`${inputClass} text-center font-mono text-2xl tracking-[.4em]`} placeholder="••••••" />
            </label>
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              New password
              <input required type="password" autoComplete="new-password" minLength={8} value={forgotNewPassword} onChange={e => setForgotNewPassword(e.target.value)} className={inputClass} placeholder="At least 8 characters" />
            </label>
            <Button disabled={resetWithOtp.isPending} className="mt-1 h-11 rounded-xl bg-[#10233f] font-bold hover:bg-[#19375f]">
              {resetWithOtp.isPending ? <Loader2 className="animate-spin" size={17} /> : <><KeyRound className="mr-2" size={17} />Reset password</>}
            </Button>
            <button type="button" onClick={() => setForgotStep("email")} className="flex items-center justify-center gap-1 text-sm font-bold text-slate-600 hover:underline">
              <ArrowLeft size={15} /> Back
            </button>
          </form>
        )}

        {mode === "forgot" && forgotDone && (
          <div className="mt-7 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm leading-6 text-emerald-900">
            <p className="font-extrabold">Password updated.</p>
            <p className="mt-1">Your password has been changed. You can now sign in with your new password.</p>
            <button onClick={() => switchMode("signin")} className="mt-3 flex items-center gap-1 font-bold text-[#13897f] hover:underline">
              <ArrowLeft size={15} /> Back to sign in
            </button>
          </div>
        )}

        <p className="mt-6 text-xs leading-5 text-slate-500">Sign-in attempts are rate-limited. If you do not have authorized credentials, return to the public site.</p>
      </section>
    </main>
  );
}
