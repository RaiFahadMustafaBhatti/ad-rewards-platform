import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { AdminCampaigns, AdminDashboard, AdminPackages, AdminPayments, AdminRisk, AdminUsers, AdminWithdrawals } from "@/pages/AdminPages";
import { MemberEarnings, MemberNotifications } from "@/pages/MemberActivity";
import { MemberAds, MemberMembership, MemberOverview, MemberProfile, MemberWithdrawals } from "@/pages/MemberPages";
import { ContactPage, HowItWorksPage, PackagesPage, PolicyPage } from "@/pages/PublicPages";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/how-it-works"} component={HowItWorksPage} />
      <Route path={"/packages"} component={PackagesPage} />
      <Route path={"/about"}>{() => <PolicyPage kind="about" />}</Route>
      <Route path={"/terms"}>{() => <PolicyPage kind="terms" />}</Route>
      <Route path={"/privacy"}>{() => <PolicyPage kind="privacy" />}</Route>
      <Route path={"/refunds"}>{() => <PolicyPage kind="refunds" />}</Route>
      <Route path={"/disclosures"}>{() => <PolicyPage kind="disclosure" />}</Route>
      <Route path={"/contact"} component={ContactPage} />
      <Route path={"/dashboard"}>{() => <MemberRoute><MemberOverview /></MemberRoute>}</Route>
      <Route path={"/dashboard/ads"}>{() => <MemberRoute><MemberAds /></MemberRoute>}</Route>
      <Route path={"/dashboard/earnings"}>{() => <MemberRoute><MemberEarnings /></MemberRoute>}</Route>
      <Route path={"/dashboard/membership"}>{() => <MemberRoute><MemberMembership /></MemberRoute>}</Route>
      <Route path={"/dashboard/withdrawals"}>{() => <MemberRoute><MemberWithdrawals /></MemberRoute>}</Route>
      <Route path={"/dashboard/notifications"}>{() => <MemberRoute><MemberNotifications /></MemberRoute>}</Route>
      <Route path={"/dashboard/profile"}>{() => <MemberRoute><MemberProfile /></MemberRoute>}</Route>
      <Route path={"/admin"}>{() => <AdminRoute><AdminDashboard /></AdminRoute>}</Route>
      <Route path={"/admin/payments"}>{() => <AdminRoute><AdminPayments /></AdminRoute>}</Route>
      <Route path={"/admin/withdrawals"}>{() => <AdminRoute><AdminWithdrawals /></AdminRoute>}</Route>
      <Route path={"/admin/campaigns"}>{() => <AdminRoute><AdminCampaigns /></AdminRoute>}</Route>
      <Route path={"/admin/packages"}>{() => <AdminRoute><AdminPackages /></AdminRoute>}</Route>
      <Route path={"/admin/risk"}>{() => <AdminRoute><AdminRisk /></AdminRoute>}</Route>
      <Route path={"/admin/users"}>{() => <AdminRoute><AdminUsers /></AdminRoute>}</Route>
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function MemberRoute({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center bg-[#f7f8fc] text-sm text-slate-500">Loading account permissions…</div>;
  if (user && user.role !== "admin") return <div className="grid min-h-screen place-items-center bg-[#f7f8fc] px-4 text-center"><div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><p className="text-sm font-extrabold uppercase tracking-[.15em] text-[#168d86]">Restricted workspace</p><h1 className="mt-3 text-2xl font-extrabold">Administrator access required</h1><p className="mt-3 text-sm leading-6 text-slate-600">Your account does not have permission to use administrative controls.</p></div></div>;
  return <DashboardLayout>{children}</DashboardLayout>;
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
