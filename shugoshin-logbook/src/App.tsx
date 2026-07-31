import ErrorBoundary from "@/components/ErrorBoundary";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import UnassignedAlert from "@/components/UnassignedAlert";
import OfflineBanner from "@/components/OfflineBanner";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import CheckIn from "./pages/CheckIn";
import OrganizationSettings from "./pages/OrganizationSettings";
import NotFound from "./pages/NotFound";
import Simulator from "./pages/Simulator";
import Report from "./pages/Report";
import DeliveryStatus from "./pages/DeliveryStatus";
import DailyReportConfirm from "./pages/DailyReportConfirm";
import SharedReportView from "./pages/SharedReportView";
import AdminDashboard from "./pages/AdminDashboard";
import PendingPunches from "./pages/PendingPunches";

const queryClient = new QueryClient();

function SplashScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-primary">
      <div className="animate-pulse flex flex-col items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-accent">
          <img src="/icon-192.png" alt="守護神" className="h-10 w-10 rounded-lg" />
        </div>
        <h1 className="text-3xl font-bold text-primary-foreground">守護神</h1>
        <p className="text-sm text-primary-foreground/60">読み込み中...</p>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <SplashScreen />;
  if (!user) return <Navigate to="/auth" replace />;
  return (
    <>
      <UnassignedAlert />
      {children}
    </>
  );
}

// 管理者専用ルート: user_roles テーブルで admin ロールを確認
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          console.error("[AdminRoute] Role check failed:", error);
          setIsAdmin(false);
        } else {
          setIsAdmin(!!data);
        }
      });
  }, [user]);

  if (loading || isAdmin === null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">権限を確認中...</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;
  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10">
          <Lock className="h-8 w-8 text-destructive" />
        </div>
        <h2 className="text-xl font-bold text-foreground">⛔ アクセス権限がありません</h2>
        <p className="text-muted-foreground">このページは管理者専用です。</p>
        <Button variant="outline" onClick={() => navigate("/")}>トップページへ戻る</Button>
      </div>
    );
  }
  return <>{children}</>;
}

const App = () => {
  const online = useOnlineStatus();
  return (
  <ErrorBoundary>
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      {!online && <OfflineBanner />}
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/auth" element={<Auth />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/orders"
              element={
                <ProtectedRoute>
                  <Orders />
                </ProtectedRoute>
              }
            />
            <Route
              path="/check-in"
              element={
                <ProtectedRoute>
                  <CheckIn />
                </ProtectedRoute>
              }
            />
            <Route
              path="/organization-settings"
              element={
                <ProtectedRoute>
                  <OrganizationSettings />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings/organization"
              element={
                <ProtectedRoute>
                  <AdminRoute>
                    <OrganizationSettings />
                  </AdminRoute>
                </ProtectedRoute>
              }
            />
            <Route
              path="/report"
              element={
                <ProtectedRoute>
                  <AdminRoute>
                    <Report />
                  </AdminRoute>
                </ProtectedRoute>
              }
            />
            <Route
              path="/delivery-status"
              element={
                <ProtectedRoute>
                  <DeliveryStatus />
                </ProtectedRoute>
              }
            />
            <Route
              path="/daily-report"
              element={
                <ProtectedRoute>
                  <DailyReportConfirm />
                </ProtectedRoute>
              }
            />
            <Route path="/simulator" element={<Simulator />} />
            <Route path="/shared-report/:id" element={<SharedReportView />} />
            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <AdminRoute>
                    <AdminDashboard />
                  </AdminRoute>
                </ProtectedRoute>
              }
            />
            <Route
              path="/pending-punches"
              element={
                <ProtectedRoute>
                  <AdminRoute>
                    <PendingPunches />
                  </AdminRoute>
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </ErrorBoundary>
  );
};

export default App;
