import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { LockKeyhole, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

export default function AdminAccess() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const login = trpc.auth.localAdminLogin.useMutation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await login.mutateAsync({ email, password });
      await utils.auth.me.invalidate();
      await utils.auth.me.fetch();
      setPassword("");
      window.location.assign("/admin");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Administrator sign-in could not be completed.");
    }
  };
  return <main className="grid min-h-screen place-items-center bg-[#f7f8fc] px-4 py-10"><section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-[0_22px_60px_rgba(16,35,63,.12)] sm:p-9"><button onClick={() => setLocation("/")} className="flex items-center gap-2 text-left font-extrabold text-[#10233f]"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#10233f] text-sm font-black text-[#6ee7dc]">F</span>FMB Earning Hub</button><div className="mt-10"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#e9fbf8] text-[#13897f]"><LockKeyhole size={23} /></span><p className="mt-5 text-xs font-extrabold uppercase tracking-[.18em] text-[#13897f]">Restricted workspace</p><h1 className="mt-2 text-3xl font-extrabold tracking-[-.04em] text-[#10233f]">Administrator access</h1><p className="mt-3 text-sm leading-6 text-slate-600">Use the designated administrator credentials. This secure local access path avoids the external verification delay and is limited to the configured administrator account.</p></div><form onSubmit={submit} className="mt-7 grid gap-4"><label className="grid gap-1.5 text-sm font-bold text-slate-700">Administrator email<input required type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} className="h-11 rounded-xl border border-slate-200 px-3 outline-none focus:border-[#20bdb2]" /></label><label className="grid gap-1.5 text-sm font-bold text-slate-700">Password<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="h-11 rounded-xl border border-slate-200 px-3 outline-none focus:border-[#20bdb2]" /></label><Button disabled={login.isPending} className="mt-2 h-11 rounded-xl bg-[#10233f] font-bold hover:bg-[#19375f]">{login.isPending ? <Loader2 className="animate-spin" size={17} /> : <><ShieldCheck className="mr-2" size={17} />Open administrator dashboard</>}</Button></form><p className="mt-6 text-xs leading-5 text-slate-500">Sign-in attempts are rate-limited. If you do not have authorized credentials, return to the public site.</p></section></main>;
}
