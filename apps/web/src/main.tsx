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
  CalendarDays,
  Database,
  Gauge,
  LogIn,
  LogOut,
  Radio,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import React from "react";
import ReactDOM from "react-dom/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  api,
  clearAuthToken,
  consumeOidcCallbackToken,
  getAuthToken,
  setAuthToken,
} from "@/lib/api";
import {
  rootLayoutNavItems,
  rootLayoutPermissions,
  type RootNavItem,
} from "@/lib/root-layout-helpers";
import { AccessPage } from "@/pages/access";
import { AuditPage } from "@/pages/audit";
import { DashboardPage } from "@/pages/dashboard";
import { NodesPage } from "@/pages/nodes";
import { RecordingsPage } from "@/pages/recordings";
import { ScheduleDetailPage } from "@/pages/schedule-detail";
import { SchedulesPage } from "@/pages/schedules";
import { SettingsPage } from "@/pages/settings";

import "./styles.css";

const queryClient = new QueryClient();

const navIcons: Record<RootNavItem["id"], typeof Gauge> = {
  access: Users,
  audit: ShieldCheck,
  dashboard: Gauge,
  nodes: Radio,
  recordings: Database,
  schedules: CalendarDays,
  settings: Settings,
};

function RootLayout() {
  const queryClient = useQueryClient();
  const [authToken, setAuthTokenState] = React.useState(
    () => consumeOidcCallbackToken() ?? getAuthToken(),
  );
  const currentUserQuery = useQuery({
    enabled: Boolean(authToken),
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
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
  if (!authToken || currentUserQuery.isError) {
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

  if (currentUserQuery.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-100 text-sm text-muted-foreground">
        Loading Rakkr
      </div>
    );
  }

  const currentUser = currentUserQuery.data.data;
  const layoutPermissions = rootLayoutPermissions(currentUser);
  const canCreateRecording = layoutPermissions.canCreateRecording;
  const canReadSettings = layoutPermissions.canReadSettings;
  const navItems = rootLayoutNavItems(layoutPermissions);

  return (
    <div className="min-h-screen bg-stone-100 text-foreground">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-border bg-panel px-4 py-5 lg:block">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-950 text-white">
            <Radio className="size-5" />
          </div>
          <div>
            <div className="text-lg font-semibold">Rakkr</div>
            <div className="text-xs text-muted-foreground">Controller</div>
          </div>
        </div>

        <nav className="grid gap-1">
          {navItems.map((item) => {
            const Icon = navIcons[item.id];

            return (
              <Link
                activeProps={{
                  className: "bg-stone-100 text-zinc-950",
                }}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
                key={item.to}
                to={item.to}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-border bg-stone-100/90 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-normal">Operations</h1>
              <p className="text-sm text-muted-foreground">Council Chamber Rack</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden text-right text-sm md:block">
                <div className="font-medium">{currentUser.name}</div>
                <div className="text-xs text-muted-foreground">{currentUser.roles.join(", ")}</div>
              </div>
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
              <Button
                disabled={!canCreateRecording}
                title={canCreateRecording ? "Start recording" : "Requires recording create"}
              >
                <Radio className="size-4" />
                Record
              </Button>
            </div>
          </div>
        </header>

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
    <div className="flex min-h-screen items-center justify-center bg-stone-100 px-4">
      <section className="w-full max-w-sm rounded-lg border border-border bg-panel p-5 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-950 text-white">
            <Radio className="size-5" />
          </div>
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
            <p className="text-sm text-red-700">Invalid email or password.</p>
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

const schedulesRoute = createRoute({
  component: SchedulesPage,
  getParentRoute: () => rootRoute,
  path: "/schedules",
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

const recordingsRoute = createRoute({
  component: RecordingsPage,
  getParentRoute: () => rootRoute,
  path: "/recordings",
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
  schedulesRoute,
  scheduleDetailRoute,
  recordingsRoute,
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
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
