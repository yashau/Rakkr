import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import {
  AudioLines,
  Building2,
  CalendarDays,
  Database,
  Gauge,
  HeartPulse,
  LogIn,
  LogOut,
  ListChecks,
  Menu,
  RadioReceiver,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";

import { toast } from "sonner";

import { RakkrLogo } from "@/components/rakkr-logo";
import { RecordingStartPanel } from "@/components/recording-start-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  api,
  clearAuthToken,
  consumeOidcCallbackToken,
  getAuthToken,
  setAuthToken,
} from "@/lib/api";
import { authGateState } from "@/lib/auth-gate";
import {
  rootLayoutNavItems,
  rootLayoutPermissions,
  rootLayoutRecordActionState,
  type RootNavItem,
} from "@/lib/root-layout-helpers";
import { AccessPage } from "@/pages/access";
import { AuditPage } from "@/pages/audit";
import { DashboardPage } from "@/pages/dashboard";
import { HealthPage } from "@/pages/health";
import { JobsPage } from "@/pages/jobs";
import { NodesPage } from "@/pages/nodes";
import { RecordingsPage } from "@/pages/recordings";
import { RoomDetailPage } from "@/pages/room-detail";
import { RoomsPage } from "@/pages/rooms";
import { ScheduleDetailPage } from "@/pages/schedule-detail";
import { SchedulesCalendarPage } from "@/pages/schedules-calendar";
import { SchedulesPage } from "@/pages/schedules";
import { SettingsPage } from "@/pages/settings";

import "./styles.css";

const queryClient = new QueryClient();

// Stamped from the controller release tag at image build time (see Dockerfile.web
// ARG RAKKR_WEB_VERSION); dev builds report the sentinel.
const webVersion = import.meta.env.VITE_RAKKR_WEB_VERSION ?? "0.0.0-dev";

const navIcons: Record<RootNavItem["id"], typeof Gauge> = {
  access: Users,
  audit: ShieldCheck,
  dashboard: Gauge,
  health: HeartPulse,
  jobs: ListChecks,
  nodes: RadioReceiver,
  recordings: Database,
  rooms: Building2,
  schedules: CalendarDays,
  settings: Settings,
};

function NavLinks({ navItems, onNavigate }: { navItems: RootNavItem[]; onNavigate?: () => void }) {
  return (
    <nav className="grid gap-1">
      {navItems.map((item) => {
        const Icon = navIcons[item.id];

        return (
          <Link
            activeProps={{ className: "bg-accent text-accent-foreground" }}
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            key={item.to}
            onClick={onNavigate}
            to={item.to}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function RootLayout() {
  const queryClient = useQueryClient();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [authToken, setAuthTokenState] = React.useState(
    () => consumeOidcCallbackToken() ?? getAuthToken(),
  );
  const [quickRecordOpen, setQuickRecordOpen] = React.useState(false);
  const currentUserQuery = useQuery({
    enabled: Boolean(authToken),
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    retry: false,
  });
  const controllerSettingsQuery = useQuery({
    enabled: Boolean(authToken),
    queryFn: api.controllerSettings,
    queryKey: ["controller-settings"],
    retry: false,
  });
  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      clearAuthToken();
      setAuthTokenState(null);
      queryClient.clear();
    },
  });
  const gate = authGateState({
    error: currentUserQuery.error,
    hasToken: Boolean(authToken),
    isError: currentUserQuery.isError,
    isPending: currentUserQuery.isPending,
  });
  React.useEffect(() => {
    // A 401/403 means the stored token is dead: clear it so a reload does not
    // replay the failing request. Transient 5xx/network errors keep the token
    // (gate === "session-error") so a blip does not force a re-login.
    if (authToken && gate === "unauthenticated") {
      clearAuthToken();
      setAuthTokenState(null);
    }
  }, [authToken, gate]);

  if (gate === "unauthenticated") {
    return (
      <LoginScreen
        onLogin={(token) => {
          setAuthToken(token);
          setAuthTokenState(token);
          queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
        }}
      />
    );
  }

  if (gate === "session-error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="grid w-full max-w-sm gap-4 rounded-lg border border-border bg-panel p-6 text-center">
          <RakkrLogo className="mx-auto size-10" />
          <div className="grid gap-1">
            <h1 className="text-base font-semibold text-foreground">Controller unavailable</h1>
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t reach the Rakkr controller. Your session is still active — retry in a
              moment.
            </p>
          </div>
          <Button onClick={() => void currentUserQuery.refetch()}>Retry</Button>
        </div>
      </div>
    );
  }

  if (!currentUserQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <output aria-label="Loading Rakkr" className="grid w-full max-w-xs gap-3">
          <div className="flex items-center gap-3">
            <RakkrLogo className="size-10" />
            <Skeleton className="h-5 w-28" />
          </div>
          <Skeleton className="h-24 w-full" />
        </output>
      </div>
    );
  }

  const currentUser = currentUserQuery.data.data;
  const layoutPermissions = rootLayoutPermissions(currentUser);
  const canReadSettings = layoutPermissions.canReadSettings;
  const navItems = rootLayoutNavItems(layoutPermissions);
  const recordAction = rootLayoutRecordActionState(layoutPermissions);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-border bg-panel px-4 py-5 lg:block">
        <div className="mb-8 flex items-center gap-3">
          <RakkrLogo className="size-10" />
          <div>
            <div className="text-lg font-semibold">Rakkr</div>
            <div className="text-xs text-muted-foreground">Controller</div>
          </div>
        </div>

        <NavLinks navItems={navItems} />

        <div className="absolute inset-x-4 bottom-5 text-xs text-muted-foreground">
          v{webVersion}
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-border bg-background/90 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Sheet onOpenChange={setMobileNavOpen} open={mobileNavOpen}>
                <SheetTrigger asChild>
                  <Button
                    aria-label="Open navigation"
                    className="lg:hidden"
                    size="icon"
                    variant="outline"
                  >
                    <Menu className="size-4" />
                  </Button>
                </SheetTrigger>
                <SheetContent className="w-64 p-4" side="left">
                  <SheetTitle className="mb-4 flex items-center gap-2 text-lg font-semibold">
                    <RakkrLogo className="size-6" />
                    Rakkr
                  </SheetTitle>
                  <NavLinks navItems={navItems} onNavigate={() => setMobileNavOpen(false)} />
                  <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
                    <span className="text-sm font-medium text-muted-foreground">Dark mode</span>
                    <ThemeToggle />
                  </div>
                </SheetContent>
              </Sheet>
              <div>
                <h1 className="text-lg font-semibold tracking-normal">Operations</h1>
                <p className="text-sm text-muted-foreground">
                  {controllerSettingsQuery.data?.data.controllerName ?? "Rakkr Controller"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden text-right text-sm md:block">
                <div className="font-medium">{currentUser.name}</div>
                <div className="text-xs text-muted-foreground">{currentUser.roles.join(", ")}</div>
              </div>
              <ThemeToggle className="mr-1 hidden md:flex" />
              {canReadSettings ? (
                <Button asChild variant="outline">
                  <Link to="/settings">
                    <Settings className="size-4" />
                    Settings
                  </Link>
                </Button>
              ) : null}
              <Button
                disabled={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
                variant="outline"
              >
                <LogOut className="size-4" />
                Logout
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      disabled={!recordAction.canOpen}
                      onClick={() => setQuickRecordOpen((open) => !open)}
                      variant={quickRecordOpen ? "secondary" : "default"}
                    >
                      <AudioLines className="size-4" />
                      Record
                    </Button>
                  </span>
                </TooltipTrigger>
                {recordAction.title ? <TooltipContent>{recordAction.title}</TooltipContent> : null}
              </Tooltip>
            </div>
          </div>
        </header>

        {quickRecordOpen ? (
          <section className="border-b border-border bg-background p-4 md:px-6">
            <div className="mx-auto grid max-w-7xl gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">Quick Recording</h2>
                  <p className="text-xs text-muted-foreground">Ad-hoc recording job</p>
                </div>
                <Button
                  aria-label="Close quick recording"
                  onClick={() => setQuickRecordOpen(false)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X className="size-4" />
                </Button>
              </div>

              <RecordingStartPanel
                canReadNodes={layoutPermissions.canReadNodes}
                canReadSettings={layoutPermissions.canReadSettings}
                onNotice={(notice) => toast.success(notice.title, { description: notice.detail })}
              />
            </div>
          </section>
        ) : null}

        <main className="mx-auto max-w-7xl px-4 py-5 md:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = React.useState("admin@rakkr.local");
  const [password, setPassword] = React.useState("");
  const oidcConfigQuery = useQuery({
    queryFn: api.oidcConfig,
    queryKey: ["auth", "oidc-config"],
    retry: false,
  });
  const loginMutation = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (response) => onLogin(response.data.token),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-border bg-panel p-5 shadow-sm">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <RakkrLogo className="size-12" />
          <div>
            <h1 className="text-lg font-semibold">Rakkr</h1>
            <p className="text-sm text-muted-foreground">Local controller sign in</p>
          </div>
        </div>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            loginMutation.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="login-email">Email</Label>
            <Input
              autoComplete="username"
              className="h-10 bg-background"
              id="login-email"
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="login-password">Password</Label>
            <Input
              autoComplete="current-password"
              className="h-10 bg-background"
              id="login-password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </div>

          {loginMutation.isError ? (
            <p className="text-sm text-destructive">Invalid email or password.</p>
          ) : null}

          <Button disabled={loginMutation.isPending} type="submit">
            <ShieldCheck className="size-4" />
            Sign In
          </Button>

          {oidcConfigQuery.data?.data.loginAvailable ? (
            <Button
              onClick={() => window.location.assign(api.oidcLoginUrl())}
              type="button"
              variant="outline"
            >
              <LogIn className="size-4" />
              Sign In With Azure AD
            </Button>
          ) : null}
        </form>
      </section>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  component: DashboardPage,
  getParentRoute: () => rootRoute,
  path: "/",
});

const nodesRoute = createRoute({
  component: NodesPage,
  getParentRoute: () => rootRoute,
  path: "/nodes",
});

const healthRoute = createRoute({
  component: HealthPage,
  getParentRoute: () => rootRoute,
  path: "/health",
});

const schedulesRoute = createRoute({
  component: SchedulesPage,
  getParentRoute: () => rootRoute,
  path: "/schedules",
});

const schedulesCalendarRoute = createRoute({
  component: SchedulesCalendarPage,
  getParentRoute: () => rootRoute,
  path: "/schedules/calendar",
});

function ScheduleDetailRouteComponent() {
  const { scheduleId } = useParams({ from: "/schedules/$scheduleId" });

  return <ScheduleDetailPage scheduleId={scheduleId} />;
}

const scheduleDetailRoute = createRoute({
  component: ScheduleDetailRouteComponent,
  getParentRoute: () => rootRoute,
  path: "/schedules/$scheduleId",
});

const roomsRoute = createRoute({
  component: RoomsPage,
  getParentRoute: () => rootRoute,
  path: "/rooms",
});

function RoomDetailRouteComponent() {
  const { roomId } = useParams({ from: "/rooms/$roomId" });

  return <RoomDetailPage roomId={roomId} />;
}

const roomDetailRoute = createRoute({
  component: RoomDetailRouteComponent,
  getParentRoute: () => rootRoute,
  path: "/rooms/$roomId",
});

const recordingsRoute = createRoute({
  component: RecordingsPage,
  getParentRoute: () => rootRoute,
  path: "/recordings",
});

const jobsRoute = createRoute({
  component: JobsPage,
  getParentRoute: () => rootRoute,
  path: "/jobs",
});

const settingsRoute = createRoute({
  component: SettingsPage,
  getParentRoute: () => rootRoute,
  path: "/settings",
});

const auditRoute = createRoute({
  component: AuditPage,
  getParentRoute: () => rootRoute,
  path: "/audit",
});

const accessRoute = createRoute({
  component: AccessPage,
  getParentRoute: () => rootRoute,
  path: "/access",
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  nodesRoute,
  healthRoute,
  schedulesRoute,
  schedulesCalendarRoute,
  scheduleDetailRoute,
  roomsRoute,
  roomDetailRoute,
  recordingsRoute,
  jobsRoute,
  settingsRoute,
  auditRoute,
  accessRoute,
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange enableSystem>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <RouterProvider router={router} />
          <Toaster position="bottom-right" richColors />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
