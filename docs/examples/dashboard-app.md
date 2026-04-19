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
    nodes: () => (theme() === "light" ? "Dark Mode" : "Light Mode"),
    on: {
      click: () => ThemeContext.set(theme() === "light" ? "dark" : "light"),
    },
  }) as HTMLElement;
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

  return div({
    class: "header",
    nodes: [
      button({
        class: "menu-btn",
        nodes: "\u2630",
        on: { click: () => store.dispatch("toggleSidebar") },
      }),
      h1({ nodes: "Dashboard" }),
      div({
        class: "header-right",
        nodes: [
          when(
            () => notifications() > 0,
            () =>
              span({
                class: "badge",
                nodes: () => `${notifications()}`,
                on: { click: () => store.dispatch("clearNotifications") },
              }) as HTMLElement
          ),
          span({ nodes: () => userName() }),
          ThemeToggle(),
        ],
      }),
    ],
  }) as HTMLElement;
}

function Sidebar(): HTMLElement {
  const isOpen = derived(() => store.getState().sidebarOpen);

  return nav({
    class: () => `sidebar ${isOpen() ? "open" : "closed"}`,
    nodes: [
      RouterLink({ to: "/", nodes: "Overview" }),
      RouterLink({ to: "/users", nodes: "Users" }),
      RouterLink({ to: "/analytics", nodes: "Analytics" }),
      RouterLink({ to: "/settings", nodes: "Settings" }),
    ],
  }) as HTMLElement;
}

// ---------------------------------------------------------------------------
// Pages (lazy loaded)
// ---------------------------------------------------------------------------

// Overview page — inline
function OverviewPage(): HTMLElement {
  return div({
    class: "page",
    nodes: [
      h2({ nodes: "Overview" }),
      div({
        class: "stats-grid",
        nodes: [
          StatCard("Users", "1,234"),
          StatCard("Revenue", "$56,789"),
          StatCard("Orders", "890"),
          StatCard("Growth", "+12.5%"),
        ],
      }),
    ],
  }) as HTMLElement;
}

function StatCard(label: string, value: string): HTMLElement {
  return div({
    class: "stat-card",
    nodes: [
      p({ class: "stat-value", nodes: value }),
      p({ class: "stat-label", nodes: label }),
    ],
  }) as HTMLElement;
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

  return div({
    class: "page",
    nodes: [
      h2({ nodes: "Users (1,000 entries)" }),
      VirtualList({
        items: users,
        itemHeight: 48,
        containerHeight: 500,
        overscan: 5,
        renderItem: (user) =>
          div({
            class: "user-row",
            nodes: [
              span({ class: "user-name", nodes: user.name }),
              span({ class: "user-email", nodes: user.email }),
              span({ class: "user-role", nodes: user.role }),
            ],
          }) as HTMLElement,
      }),
    ],
  }) as HTMLElement;
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
    nodes: [
      Header(),
      div({
        class: "main-layout",
        nodes: [
          Sidebar(),
          div({
            class: "content",
            nodes: [
              ErrorBoundary(
                {
                  fallback: (err, retry) =>
                    div({
                      class: "error-panel",
                      nodes: [
                        p({ nodes: `Error: ${err.message}` }),
                        button({ nodes: "Retry", on: { click: retry } }),
                      ],
                    }) as HTMLElement,
                },
                () =>
                  Suspense({
                    fallback: () =>
                      div({ class: "loading", nodes: "Loading..." }) as HTMLElement,
                    nodes: () => Outlet(),
                  }),
              ),
            ],
          }),
        ],
      }),
    ],
  }) as HTMLElement;
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
