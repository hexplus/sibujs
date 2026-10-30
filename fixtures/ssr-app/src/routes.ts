import type { RouteDef, RouterHeadOptions } from "../../../plugins";
import { fetchCatalog } from "./api";
import { Account, Admin } from "./pages/Admin";
import { Designer } from "./pages/Designer";
import { HelpLayout, Shipping } from "./pages/Help";
import { Landing } from "./pages/Landing";
import { NotFound } from "./pages/NotFound";
import { ProductPage } from "./pages/Product";
import { Quote } from "./pages/Quote";

export const ORIGIN = "https://fixture.test";

/** Whether the visitor has a session. A server render never does (no cookies in the fixture). */
function hasSession(): boolean {
  return typeof document !== "undefined" && document.cookie.includes("session=");
}

/** Router-wide head: defaults every route inherits. */
export const head: RouterHeadOptions = {
  title: "Estampados Sibu",
  titleTemplate: "%s · Estampados Sibu",
  description: "Personalización textil en 48 horas.",
  og: { siteName: "Estampados Sibu", type: "website", image: `${ORIGIN}/og/default.png` },
  twitter: { card: "summary_large_image" },
};

export const routes: RouteDef[] = [
  {
    path: "/",
    name: "home",
    component: Landing,
    head: {
      title: "Inicio",
      description: "Estampado DTF, vinil y bordado.",
      canonical: `${ORIGIN}/`,
      og: { image: `${ORIGIN}/og/home.png` },
      alternates: [
        { hreflang: "es", href: `${ORIGIN}/` },
        { hreflang: "en", href: `${ORIGIN}/en/` },
      ],
      jsonLd: { "@context": "https://schema.org", "@type": "Organization", name: "Estampados Sibu", url: ORIGIN },
    },
  },
  {
    path: "/producto/:id",
    name: "product",
    component: ProductPage,
    head: {
      title: (r) => `Producto ${r.params.id}`,
      canonical: (r) => `${ORIGIN}/producto/${r.params.id}`,
    },
    getStaticPaths: async () => (await fetchCatalog()).map((p) => ({ id: p.id })),
  },
  {
    path: "/cotizar",
    name: "quote",
    component: Quote,
    head: {
      title: "Cotizar",
      description: (r) => `Cotización de ${r.query.servicio ?? "servicios"}`,
      canonical: `${ORIGIN}/cotizar`,
    },
  },
  { path: "/cotizacion", redirect: "/cotizar", status: 301 },
  { path: "/galeria", name: "gallery", lazy: () => import("./pages/Gallery"), head: { title: "Galería" } },
  {
    path: "/ayuda",
    component: HelpLayout,
    head: { title: "Ayuda" },
    children: [{ path: "/envios", name: "shipping", component: Shipping, head: { title: "Envíos" } }],
  },
  {
    path: "/estado",
    name: "status",
    lazy: () => import("./pages/Status"),
    render: "ssr",
    head: { title: "Estado", robots: "noindex" },
  },
  { path: "/disenador", name: "designer", component: Designer, render: "client", head: { title: "Diseñador" } },
  {
    path: "/admin",
    name: "admin",
    component: Admin,
    render: "client",
    head: { title: "Administración", robots: "noindex, nofollow" },
  },
  { path: "/mi-cuenta", name: "account", component: Account, beforeEnter: () => hasSession(), head: { title: "Mi cuenta" } },
  { path: "/pedidos", name: "orders", component: Account, beforeEnter: () => hasSession() || "/" },
  { path: "*", name: "not-found", component: NotFound, status: 404, head: { title: "No encontrado", robots: "noindex" } },
];
