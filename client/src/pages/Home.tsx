import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { INITIAL_PACKAGES, formatDurationDays, formatPkr } from "@shared/platform";
import { ArrowRight, BadgeCheck, Check, ChevronRight, Clock3, Menu, ShieldCheck, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";

const steps = [
  ["01", "Verify your account", "Verify your account for secure access."],
  ["02", "Choose a membership", "Select a membership and pay for your access."],
  ["03", "Complete eligible ads", "View eligible ads to complete tasks."],
  ["04", "Request a payout", "Review your balance and request a payout."],
];

// Display names follow the corrected Bronze/Silver/Gold/Platinum hierarchy
// from the design critique. Package IDs and backend data are untouched.
const tierDisplayNames = ["Silver", "Gold", "Platinum"];
const tierBadgeClasses = [
  "bg-slate-200 text-slate-700",
  "bg-[#f5e3a3] text-[#5f4a0e]",
  "bg-[#d7f5f2] text-[#0a6b64]",
];
const tierFeatures = [
  ["Eligible advertising access", "Server-validated completion", "Manual withdrawal review"],
  ["Eligible advertising access", "Server-validated completion", "Manual withdrawal review", "Priority review queue", "Premium support"],
  ["Eligible advertising access", "Server-validated completion", "Manual withdrawal review", "Priority review queue", "Premium support", "Highest per-ad reward rate"],
];

const safeguards = [
  "Server-side reward validation",
  "One reward per verified ad session",
  "Campaign budget and daily-limit checks",
  "Auditable balance-change ledger",
  "Manual payment-proof review",
  "Suspicious activity review workflow",
];

export default function Home() {
  const [, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: configuredPackages } = trpc.platform.packages.useQuery();
  const availablePackages = configuredPackages && configuredPackages.length > 0 ? configuredPackages : INITIAL_PACKAGES;

  const navigate = (path: string) => {
    setMobileOpen(false);
    setLocation(path);
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f7f8fc] text-[#10233f]">
      <header className="relative z-30 border-b border-white/10 bg-[#081a32] text-white">
        <div className="container flex h-[74px] items-center justify-between">
          <button className="flex items-center gap-3 text-left" onClick={() => navigate("/")} aria-label="FMB Earning Hub home">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[#22d3c5] text-lg font-black text-[#06192f] shadow-[0_8px_24px_rgba(34,211,197,.32)]">A</span>
            <span className="text-lg font-extrabold tracking-tight">FMB Earning Hub</span>
          </button>
          <nav className="hidden items-center gap-7 text-sm font-medium text-slate-300 lg:flex">
            <button onClick={() => navigate("/")} className="transition hover:text-white">Home</button>
            <button onClick={() => navigate("/how-it-works")} className="transition hover:text-white">How it works</button>
            <button onClick={() => navigate("/packages")} className="transition hover:text-white">Memberships</button>
            <button onClick={() => navigate("/disclosures")} className="transition hover:text-white">Trust & terms</button>
            <button onClick={() => navigate("/contact")} className="transition hover:text-white">Contact</button>
          </nav>
          <div className="hidden items-center gap-3 sm:flex">
            <Button onClick={() => navigate("/packages")} variant="outline" className="rounded-xl border-white/25 bg-transparent px-5 font-bold text-white hover:bg-white/10 hover:text-white">Get Started</Button>
          </div>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="grid h-10 w-10 place-items-center rounded-xl bg-white/10 lg:hidden" aria-label="Open navigation">
            {mobileOpen ? <X size={19} /> : <Menu size={20} />}
          </button>
        </div>
        {mobileOpen && <div className="border-t border-white/10 px-4 pb-5 pt-3 lg:hidden">
          <div className="mx-auto flex max-w-xl flex-col gap-1 text-sm font-semibold text-slate-200">
            {[['Home', '/'], ['How it works', '/how-it-works'], ['Memberships', '/packages'], ['Trust & terms', '/disclosures'], ['Contact', '/contact']].map(([label, path]) => <button key={path} onClick={() => navigate(path)} className="rounded-xl px-3 py-3 text-left hover:bg-white/10">{label}</button>)}
            <Button onClick={() => navigate("/packages")} variant="outline" className="mt-2 rounded-xl border-white/25 bg-transparent font-bold text-white hover:bg-white/10 hover:text-white">Get Started</Button>
          </div>
        </div>}
      </header>

      <main>
        <section className="relative isolate overflow-hidden bg-[#081a32] pb-24 pt-16 text-white sm:pb-32 sm:pt-24">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_76%_15%,rgba(34,211,197,.22),transparent_27%),radial-gradient(circle_at_10%_80%,rgba(72,115,255,.20),transparent_27%)]" />
          <div className="container relative grid items-center gap-12 lg:grid-cols-[1.05fr_.95fr]">
            <div className="max-w-2xl">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold tracking-wide text-[#8ff4ea] backdrop-blur"><BadgeCheck size={15} /> A transparent advertising rewards service</div>
              <h1 className="max-w-xl text-4xl font-extrabold leading-[1.06] tracking-[-.045em] sm:text-5xl lg:text-6xl">Engage with eligible campaigns. <span className="text-[#6ee7dc]">Keep every step clear.</span></h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">FMB Earning Hub is built for verified advertising activity—not investments. Membership access, campaign availability, and reward eligibility are governed by published terms and validated platform rules.</p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row"><Button onClick={() => navigate("/packages")} size="lg" className="rounded-xl bg-[#22d3c5] px-6 font-extrabold text-[#06192f] hover:bg-[#8ff4ea]">Explore memberships <ArrowRight className="ml-2" size={18} /></Button><Button onClick={() => navigate("/how-it-works")} size="lg" variant="outline" className="rounded-xl border-white/20 bg-white/5 px-6 font-bold text-white hover:bg-white/10 hover:text-white">How it works</Button></div>
              <p className="mt-5 flex items-start gap-2 text-xs leading-5 text-slate-400"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#6ee7dc]" /> Membership fees do not constitute an investment. Eligible rewards depend on active campaigns, verified completion, package rules, and platform terms.</p>
            </div>
            <div className="relative mx-auto w-full max-w-[470px]">
              <div className="absolute -inset-5 rounded-[2rem] bg-[#22d3c5]/10 blur-2xl" />
              <div className="relative rounded-[1.8rem] border border-white/15 bg-white/[.07] p-4 shadow-2xl backdrop-blur-xl sm:p-5"><div className="rounded-[1.25rem] bg-[#f8fafc] p-5 text-[#10233f] sm:p-6"><div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-slate-500">Eligibility overview</p><h2 className="mt-1 text-xl font-extrabold">Your activity, explained</h2></div><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e6faf8] text-[#0f8f87]"><Sparkles size={19} /></span></div><div className="mt-6 grid gap-3"><div className="rounded-2xl border border-slate-200 bg-white p-4"><div className="flex items-center justify-between"><span className="text-sm font-bold">Campaign access</span><span className="rounded-full bg-[#e9faf8] px-2.5 py-1 text-xs font-bold text-[#0e8078]">Validated</span></div><p className="mt-2 text-sm leading-5 text-slate-500">Only currently active campaigns that meet eligibility controls appear in your dashboard.</p></div><div className="rounded-2xl border border-slate-200 bg-white p-4"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#eef2ff] text-[#4c62c8]"><Clock3 size={18} /></span><div><p className="text-sm font-bold">Completion matters</p><p className="text-xs text-slate-500">Session time is checked before a reward is recorded.</p></div></div></div><div className="rounded-2xl bg-[#10233f] p-4 text-white"><p className="text-xs font-bold uppercase tracking-[.15em] text-[#6ee7dc]">Platform standard</p><p className="mt-2 text-sm font-semibold leading-5">No guaranteed returns. No automatic payments. A documented review trail for every material action.</p></div></div></div></div>
            </div>
          </div>
        </section>

        <section className="container py-20 sm:py-28"><div className="max-w-2xl"><p className="text-xs font-extrabold uppercase tracking-[.2em] text-[#168d86]">How participation works</p><h2 className="mt-3 text-3xl font-extrabold tracking-[-.035em] sm:text-4xl">A clear path from account to documented request.</h2></div><div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">{steps.map(([number, title, description]) => <article key={number} className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_12px_32px_rgba(16,35,63,.05)] transition duration-200 hover:-translate-y-1 hover:shadow-[0_18px_40px_rgba(16,35,63,.1)]"><p className="text-sm font-extrabold text-[#22aaa1]">{number}</p><h3 className="mt-9 text-lg font-extrabold">{title}</h3><p className="mt-3 text-sm leading-6 text-slate-600">{description}</p><div className="mt-6 h-px w-full bg-slate-100"><span className="block h-px w-0 bg-[#22d3c5] transition-all duration-300 group-hover:w-full" /></div></article>)}</div></section>

        <section className="border-y border-slate-200 bg-white py-20 sm:py-28"><div className="container"><div className="flex flex-col justify-between gap-5 md:flex-row md:items-end"><div className="max-w-2xl"><p className="text-xs font-extrabold uppercase tracking-[.2em] text-[#168d86]">Membership access</p><h2 className="mt-3 text-3xl font-extrabold tracking-[-.035em] sm:text-4xl">Review the rules before you submit payment details.</h2><p className="mt-4 text-base leading-7 text-slate-600">Initial package terms are editable by an administrator. The values below are access terms, not investment promises.</p></div><button onClick={() => navigate("/packages")} className="inline-flex items-center gap-1 text-sm font-extrabold text-[#0e8078] hover:text-[#075d57]">Compare all packages <ChevronRight size={17} /></button></div><div className="mt-10 grid gap-5 lg:grid-cols-3">{availablePackages.map((tier, index) => <div key={tier.name}><p className="mb-3 text-center text-xs font-extrabold uppercase tracking-[.22em] text-slate-400">Tier {index + 1}</p><article className={`relative overflow-hidden rounded-[1.6rem] border p-6 ${index === 1 ? "border-[#d6b750] bg-[#fffdf5] shadow-[0_18px_40px_rgba(180,145,30,.12)]" : "border-slate-200 bg-white"}`}>{index === 1 && <span className="absolute right-5 top-5 rounded-full bg-[#f5e3a3] px-2.5 py-1 text-[11px] font-extrabold text-[#5f4a0e]">Popular</span>}<span className={`inline-flex rounded-xl px-3 py-1.5 text-xs font-extrabold ${tierBadgeClasses[index] ?? tierBadgeClasses[0]}`}>{tierDisplayNames[index] ?? tier.name}</span><p className="mt-6 text-3xl font-extrabold tracking-[-.04em]">{formatPkr(tier.pricePaisa)}</p><p className="mt-1 text-sm text-slate-500">Membership fee</p><div className="mt-6 grid grid-cols-2 gap-3 border-y border-slate-100 py-5"><div><p className="text-xs text-slate-500">Per eligible ad</p><p className="mt-1 text-sm font-extrabold">{formatPkr(tier.rewardPerEligibleAdPaisa)}</p></div><div><p className="text-xs text-slate-500">Initial daily limit</p><p className="mt-1 text-sm font-extrabold">{tier.dailyAdLimit === 1 ? "1 ad" : `${tier.dailyAdLimit} ads`}</p></div></div><ul className="mt-5 space-y-3">{(tierFeatures[index] ?? []).map(feature => <li key={feature} className="flex gap-2 text-sm text-slate-600"><Check size={16} className="mt-0.5 shrink-0 text-[#18a59c]" />{feature}</li>)}</ul><Button onClick={() => navigate("/packages")} className="mt-7 w-full rounded-xl bg-[#10233f] font-bold hover:bg-[#19375f]">Review package terms</Button></article></div>)}</div></div></section>

        <section className="container grid gap-10 py-20 sm:py-28 lg:grid-cols-[.85fr_1.15fr] lg:items-center"><div><p className="text-xs font-extrabold uppercase tracking-[.2em] text-[#168d86]">Designed for responsible operations</p><h2 className="mt-3 text-3xl font-extrabold tracking-[-.035em] sm:text-4xl">Safeguards are part of the experience, not fine print.</h2><p className="mt-5 max-w-xl leading-7 text-slate-600">The platform is structured to validate activity before recording rewards, retain an audit trail for balance changes, and let administrators investigate flagged behavior instead of manipulating records without accountability.</p><Button onClick={() => navigate("/disclosures")} variant="outline" className="mt-7 rounded-xl border-slate-300 bg-white font-bold">Read disclosures <ArrowRight className="ml-2" size={17} /></Button></div><div className="grid gap-3 sm:grid-cols-2">{safeguards.map((item, index) => <div key={item} className="flex min-h-28 items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_10px_24px_rgba(16,35,63,.04)]"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#ebfbf9] font-extrabold text-[#10877f]">0{index + 1}</span><p className="text-sm font-bold leading-5">{item}</p></div>)}</div></section>
        <section className="border-t border-slate-200 bg-white py-20"><div className="container grid gap-8 lg:grid-cols-[.7fr_1.3fr]"><div><p className="text-xs font-extrabold uppercase tracking-[.2em] text-[#168d86]">Frequently asked questions</p><h2 className="mt-3 text-3xl font-extrabold tracking-[-.035em]">Clear answers before you participate.</h2><p className="mt-4 max-w-md text-sm leading-6 text-slate-600">Read the full terms and contact support before completing any membership payment or request.</p></div><div className="divide-y divide-slate-200 rounded-2xl border border-slate-200"><details className="group p-5"><summary className="cursor-pointer list-none text-sm font-extrabold">Are rewards guaranteed?<span className="float-right text-[#168d86] group-open:rotate-45">+</span></summary><p className="mt-3 text-sm leading-6 text-slate-600">No. Rewards depend on active campaigns, verified completion, configured limits, remaining campaign budget, and platform terms.</p></details><details className="group p-5"><summary className="cursor-pointer list-none text-sm font-extrabold">Does a payment screenshot activate a membership?<span className="float-right text-[#168d86] group-open:rotate-45">+</span></summary><p className="mt-3 text-sm leading-6 text-slate-600">No. Payment proof remains pending until an administrator verifies the transaction and approves the associated membership.</p></details><details className="group p-5"><summary className="cursor-pointer list-none text-sm font-extrabold">How are withdrawals handled?<span className="float-right text-[#168d86] group-open:rotate-45">+</span></summary><p className="mt-3 text-sm leading-6 text-slate-600">Eligible funds are held when a request is submitted. An administrator reviews it and records a payment reference or documented reversal outcome.</p></details><details className="group p-5"><summary className="cursor-pointer list-none text-sm font-extrabold">What activity may be reviewed?<span className="float-right text-[#168d86] group-open:rotate-45">+</span></summary><p className="mt-3 text-sm leading-6 text-slate-600">The platform may review duplicate sessions, abnormal viewing patterns, payment proof duplication, repeated attempts, and related security signals.</p></details></div></div></section>
        <section className="bg-[#dff8f5] py-16"><div className="container flex flex-col items-start justify-between gap-6 md:flex-row md:items-center"><div><p className="text-sm font-extrabold text-[#0e8078]">Ready to review the terms?</p><h2 className="mt-2 text-2xl font-extrabold tracking-[-.03em] sm:text-3xl">Start with a package that fits your campaign access needs.</h2></div><Button onClick={() => navigate("/packages")} size="lg" className="rounded-xl bg-[#10233f] px-6 font-extrabold hover:bg-[#19375f]">View memberships <ArrowRight className="ml-2" size={18} /></Button></div></section>
      </main>
      <footer className="bg-[#081a32] py-11 text-slate-300"><div className="container"><div className="flex flex-col justify-between gap-8 sm:flex-row"><div><div className="flex items-center gap-2 text-white"><span className="grid h-8 w-8 place-items-center rounded-xl bg-[#22d3c5] text-sm font-black text-[#06192f]">F</span><span className="font-extrabold">FMB Earning Hub</span></div><p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">An advertising rewards platform focused on verified activity, clear terms, and auditable requests.</p></div><div className="grid grid-cols-2 gap-x-10 gap-y-3 text-sm font-semibold"><button onClick={() => navigate("/how-it-works")} className="text-left hover:text-white">How it works</button><button onClick={() => navigate("/packages")} className="text-left hover:text-white">Memberships</button><button onClick={() => navigate("/disclosures")} className="text-left hover:text-white">Terms & disclosures</button><button onClick={() => navigate("/contact")} className="text-left hover:text-white">Contact</button><button onClick={() => navigate("/member-access")} className="text-left text-slate-500 hover:text-white">Member sign in</button><button onClick={() => navigate("/admin-access")} className="text-left text-slate-500 hover:text-white">Administrator access</button></div></div><div className="mt-10 border-t border-white/10 pt-5 text-xs leading-5 text-slate-500">Membership fees do not constitute an investment and the platform does not promise guaranteed profits or returns. Rewards are subject to eligible advertising activity, available campaigns, package rules, and applicable terms.</div></div></footer>
    </div>
  );
}
