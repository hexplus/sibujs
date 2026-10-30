import type { RouteDef } from "sibujs/plugins";
import { Home } from "./pages/Home";
import { Quote } from "./pages/Quote";

export const routes: RouteDef[] = [
  {
    path: "/",
    component: Home,
    head: {
      title: "Custom vehicle wraps",
      description: "Design your wrap online and get it installed in a day.",
      canonical: "https://wraps.example/",
      og: { image: "https://wraps.example/og/home.png" },
    },
  },
  {
    path: "/cotizar",
    component: Quote,
    head: {
      title: "Get a quote",
      description: "Tell us about your vehicle and get a price within 24 hours.",
      canonical: "https://wraps.example/cotizar",
      og: { image: "https://wraps.example/og/quote.png" },
    },
  },
  {
    path: "/galeria",
    // A lazy route: the pre-renderer waits for its chunk.
    lazy: () => import("./pages/Gallery"),
    head: {
      title: "Gallery",
      description: "Recent wraps by our studio.",
      canonical: "https://wraps.example/galeria",
    },
  },
];
