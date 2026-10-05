import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const token = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("token") ?? "";
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [done, setDone] = useState(false);

  const reset = trpc.auth.resetPassword.useMutation();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("The new passwords do not match.");
      return;
    }
    try {
      await reset.mutateAsync({ token, newPassword });
      setNewPassword("");
      setConfirmPassword("");
      setDone(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The password could not be reset.");
    }
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
            {done ? <CheckCircle2 size={23} /> : <KeyRound size={23} />}
          </span>
          <p className="mt-5 text-xs font-extrabold uppercase tracking-[.18em] text-[#13897f]">Password reset</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-[-.04em] text-[#10233f]">
            {done ? "Password updated" : "Set a new password"}
          </h1>
        </div>

        {!token && (
          <p className="mt-6 text-sm leading-6 text-slate-600">
            This reset link is missing or incomplete. Please request a new one from the{" "}
            <button onClick={() => setLocation("/member-access")} className="font-bold text-[#13897f] hover:underline">sign-in page</button>.
          </p>
        )}

        {token && !done && (
          <form onSubmit={submit} className="mt-7 grid gap-4">
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              New password
              <input required type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={e => setNewPassword(e.target.value)} className="h-11 rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-[#20bdb2]" placeholder="At least 8 characters" />
            </label>
            <label className="grid gap-1.5 text-sm font-bold text-slate-700">
              Confirm new password
              <input required type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="h-11 rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-[#20bdb2]" placeholder="Repeat the new password" />
            </label>
            <Button disabled={reset.isPending} className="mt-1 h-11 rounded-xl bg-[#10233f] font-bold hover:bg-[#19375f]">
              {reset.isPending ? <Loader2 className="animate-spin" size={17} /> : "Set new password"}
            </Button>
          </form>
        )}

        {done && (
          <div className="mt-7 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm leading-6 text-emerald-900">
            <p className="font-extrabold">Your password has been updated.</p>
            <p className="mt-1">You can now sign in with your new password.</p>
            <button onClick={() => setLocation("/member-access")} className="mt-3 font-bold text-[#13897f] hover:underline">
              Go to sign in
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
