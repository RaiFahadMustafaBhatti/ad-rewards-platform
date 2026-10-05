import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/_core/hooks/useAuth";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { lazy, Suspense } from "react";

const Home = lazy(() => import("./pages/Home"));
const DashboardLayout = lazy(() => import("@/components/DashboardLayout"));
const MemberAccess = lazy(() => import("@/pages/MemberAccess"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const NotFound = lazy(() => import("@/pages/NotFound"));
const publicPages = () => import("@/pages/PublicPages");
const memberPages = () => import("@/pages/MemberPages");
const adminPages = () => import("@/pages/AdminPages");
const memberActivity = () => import("@/pages/MemberActivity");
const ContactPage = lazy(async () => ({ default: (await publicPages()).ContactPage }));
const HowItWorksPage = lazy(async () => ({ default: (await publicPages()).HowItWorksPage }));
const PackagesPage = lazy(async () => ({ default: (await publicPages()).PackagesPage }));
const PolicyPage = lazy(async () => ({ default: (await publicPages()).PolicyPage }));
const MemberOverview = lazy(async () => ({ default: (await memberPages()).MemberOverview }));
const MemberAds = lazy(async () => ({ default: (await memberPages()).MemberAds }));
const MemberMembership = lazy(async () => ({ default: (await memberPages()).MemberMembership }));
const MemberWithdrawals = lazy(async () => ({ default: (await memberPages()).MemberWithdrawals }));
const MemberProfile = lazy(async () => ({ default: (await memberPages()).MemberProfile }));
const MemberEarnings = lazy(async () => ({ default: (await memberActivity()).MemberEarnings }));
const MemberNotifications = lazy(async () => ({ default: (await memberActivity()).MemberNotifications }));
const videoPages = () => import("@/pages/VideoPages");
const MemberVideos = lazy(async () => ({ default: (await videoPages()).MemberVideos }));
const AdminVideos = lazy(async () => ({ default: (await videoPages()).AdminVideos }));
const AdminAvailability = lazy(() => import("@/pages/AdminAvailability"));
const AdminDashboard = lazy(async () => ({ default: (await adminPages()).AdminDashboard }));
const AdminPayments = lazy(async () => ({ default: (await adminPages()).AdminPayments }));
const AdminWithdrawals = lazy(async () => ({ default: (await adminPages()).AdminWithdrawals }));
const AdminCampaigns = lazy(() => import("@/pages/AdminCampaignManager"));
const AdminPackages = lazy(async () => ({ default: (await adminPages()).AdminPackages }));
const AdminRisk = lazy(async () => ({ default: (await adminPages()).AdminRisk }));
const AdminUsers = lazy(async () => ({ default: (await adminPages()).AdminUsers }));

function RouteLoading() {
  return <div className="grid min-h-[40vh] place-items-center bg-[#f7f8fc] text-sm font-bold text-slate-500">Loading workspace…</div>;
}

function Router() {
  return (
    <Suspense fallback={<RouteLoading />}><Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/how-it-works"} component={HowItWorksPage} />
      <Route path={"/packages"} component={PackagesPage} />
      <Route path={"/about"}>{() => <PolicyPage kind="about" />}</Route>
      <Route path={"/terms"}>{() => <PolicyPage kind="terms" />}</Route>
      <Route path={"/privacy"}>{() => <PolicyPage kind="privacy" />}</Route>
      <Route path={"/refunds"}>{() => <PolicyPage kind="refunds" />}</Route>
      <Route path={"/disclosures"}>{() => <PolicyPage kind="disclosure" />}</Route>
      <Route path={"/contact"} component={ContactPage} />
      <Route path={"/member-access"} component={MemberAccess} />
      {/* The old separate admin sign-in now opens the unified sign-in page. */}
      <Route path={"/admin-access"} component={MemberAccess} />
      <Route path={"/reset-password"} component={ResetPassword} />
      <Route path={"/dashboard"}>{() => <MemberRoute><MemberOverview /></MemberRoute>}</Route>
      <Route path={"/dashboard/ads"}>{() => <MemberRoute><MemberAds /></MemberRoute>}</Route>
      <Route path={"/dashboard/videos"}>{() => <MemberRoute><MemberVideos /></MemberRoute>}</Route>
      <Route path={"/dashboard/earnings"}>{() => <MemberRoute><MemberEarnings /></MemberRoute>}</Route>
      <Route path={"/dashboard/membership"}>{() => <MemberRoute><MemberMembership /></MemberRoute>}</Route>
      <Route path={"/dashboard/withdrawals"}>{() => <MemberRoute><MemberWithdrawals /></MemberRoute>}</Route>
      <Route path={"/dashboard/notifications"}>{() => <MemberRoute><MemberNotifications /></MemberRoute>}</Route>
      <Route path={"/dashboard/profile"}>{() => <MemberRoute><MemberProfile /></MemberRoute>}</Route>
      <Route path={"/admin"}>{() => <AdminRoute><AdminDashboard /></AdminRoute>}</Route>
      <Route path={"/admin/payments"}>{() => <AdminRoute><AdminPayments /></AdminRoute>}</Route>
      <Route path={"/admin/withdrawals"}>{() => <AdminRoute><AdminWithdrawals /></AdminRoute>}</Route>
      <Route path={"/admin/campaigns"}>{() => <AdminRoute><AdminCampaigns /></AdminRoute>}</Route>
      <Route path={"/admin/videos"}>{() => <AdminRoute><AdminVideos /></AdminRoute>}</Route>
      <Route path={"/admin/availability"}>{() => <AdminRoute><AdminAvailability /></AdminRoute>}</Route>
      <Route path={"/admin/packages"}>{() => <AdminRoute><AdminPackages /></AdminRoute>}</Route>
      <Route path={"/admin/risk"}>{() => <AdminRoute><AdminRisk /></AdminRoute>}</Route>
      <Route path={"/admin/users"}>{() => <AdminRoute><AdminUsers /></AdminRoute>}</Route>
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch></Suspense>
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
