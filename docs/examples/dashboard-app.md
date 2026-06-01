# Example: Dashboard Application

A dashboard app demonstrating advanced SibuJS patterns.

## Features

- Global state with `globalStore`
- Virtual scrolling for large data tables
- Lazy-loaded route panels
- Dark mode via Context API
- Error boundaries for resilient UI

## Full Source

```ts
import {
  div, h1, h2, nav, button, span, p, table, thead, tbody, tr, th, td,
  signal, derived, mount, each, when,
  context, lazy, Suspense, ErrorBoundary,
} from "sibujs";
import { globalStore } from "sibujs/patterns";
import { VirtualList } from "sibujs/ui";
import { createRouter, RouterLink, Route, Outlet } from "sibujs/plugins";

// ---------------------------------------------------------------------------
// Theme Context
// ---------------------------------------------------------------------------

const ThemeContext = context<"light" | "dark">("light");

function ThemeToggle(): HTMLElement {
  const theme = ThemeContext.use();
  return button({
    class: () => `theme-toggle ${theme()}`,
    on: {
      click: () => ThemeContext.set(theme() === "light" ? "dark" : "light"),
    },
  }, () => (theme() === "light" ? "Dark Mode" : "Light Mode")) as HTMLElement;
}

// ---------------------------------------------------------------------------
// Global Store
// ---------------------------------------------------------------------------

interface DashboardState {
  user: { name: string; role: string } | null;
  notifications: number;
  sidebarOpen: boolean;
}

const store = globalStore<DashboardState>({
  state: {
    user: { name: "Alice", role: "Admin" },
    notifications: 3,
    sidebarOpen: true,
  },
  actions: {
    toggleSidebar: (state) => ({ sidebarOpen: !state.sidebarOpen }),
    clearNotifications: () => ({ notifications: 0 }),
    logout: () => ({ user: null, notifications: 0 }),
  },
});

// ---------------------------------------------------------------------------
// Layout Components
// ---------------------------------------------------------------------------

function Header(): HTMLElement {
  const state = store.getState;
  const notifications = derived(() => state().notifications);
  const userName = derived(() => state().user?.name ?? "Guest");

  return div("header", [
    button({
      class: "menu-btn",
      on: { click: () => store.dispatch("toggleSidebar") },
    }, "\u2630"),
    h1("Dashboard"),
    div("header-right", [
      when(
        () => notifications() > 0,
        () =>
          span({
            class: "badge",
            on: { click: () => store.dispatch("clearNotifications") },
          }, () => `${notifications()}`) as HTMLElement
      ),
      span(() => userName()),
      ThemeToggle(),
    ]),
  ]) as HTMLElement;
}

function Sidebar(): HTMLElement {
  const isOpen = derived(() => store.getState().sidebarOpen);

  return nav({
    class: () => `sidebar ${isOpen() ? "open" : "closed"}`,
  }, [
    RouterLink({ to: "/", nodes: "Overview" }),
    RouterLink({ to: "/users", nodes: "Users" }),
    RouterLink({ to: "/analytics", nodes: "Analytics" }),
    RouterLink({ to: "/settings", nodes: "Settings" }),
  ]) as HTMLElement;
}

// ---------------------------------------------------------------------------
// Pages (lazy loaded)
// ---------------------------------------------------------------------------

// Overview page — inline
function OverviewPage(): HTMLElement {
  return div("page", [
    h2("Overview"),
    div("stats-grid", [
      StatCard("Users", "1,234"),
      StatCard("Revenue", "$56,789"),
      StatCard("Orders", "890"),
      StatCard("Growth", "+12.5%"),
    ]),
  ]) as HTMLElement;
}

function StatCard(label: string, value: string): HTMLElement {
  return div("stat-card", [
    p("stat-value", value),
    p("stat-label", label),
  ]) as HTMLElement;
}

// Users page — uses VirtualList for large dataset
function UsersPage(): HTMLElement {
  const [users] = signal(
    Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      email: `user${i + 1}@example.com`,
      role: i % 3 === 0 ? "Admin" : "Member",
    }))
  );

  return div("page", [
    h2("Users (1,000 entries)"),
    VirtualList({
      items: users,
      itemHeight: 48,
      containerHeight: 500,
      overscan: 5,
      renderItem: (user) =>
        div("user-row", [
          span("user-name", user.name),
          span("user-email", user.email),
          span("user-role", user.role),
        ]) as HTMLElement,
    }),
  ]) as HTMLElement;
}

// Analytics and Settings — lazy loaded
const AnalyticsPage = lazy(() => import("./pages/Analytics"));
const SettingsPage = lazy(() => import("./pages/Settings"));

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = createRouter([
  { path: "/", component: OverviewPage },
  { path: "/users", component: UsersPage },
  { path: "/analytics", component: () => AnalyticsPage() },
  { path: "/settings", component: () => SettingsPage() },
], { mode: "history" });

// ---------------------------------------------------------------------------
// App Shell
// ---------------------------------------------------------------------------

function App(): HTMLElement {
  const theme = ThemeContext.use();

  return div({
    class: () => `app ${theme()}`,
  }, [
    Header(),
    div("main-layout", [
      Sidebar(),
      div("content", [
        ErrorBoundary(
          {
            fallback: (err, retry) =>
              div("error-panel", [
                p(`Error: ${err.message}`),
                button({ on: { click: retry } }, "Retry"),
              ]) as HTMLElement,
          },
          () =>
            Suspense({
              nodes: () => Outlet(),
              fallback: () => div("loading", "Loading...") as HTMLElement,
            }),
        ),
      ]),
    ]),
  ]) as HTMLElement;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

ThemeContext.provide("light");
mount(App, document.getElementById("app"));
```

## Key Patterns Demonstrated

| Pattern | Usage |
|---------|-------|
| `globalStore` | Dashboard state with actions |
| `context` | Theme switching (light/dark) |
| `VirtualList` | 1,000-row user table |
| `lazy` + `Suspense` | Route-based code splitting |
| `ErrorBoundary` | Resilient content area |
| `derived` | Derived state from global store |
| `when()` | Conditional notification badge |
| Reactive `class` | Sidebar open/close, theme class |
| Router | Multi-page navigation with `RouterLink` and `Outlet` |
