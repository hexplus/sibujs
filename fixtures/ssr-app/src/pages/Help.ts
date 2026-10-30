import { aside, div, h1, h2, main, nav, p } from "../../../../index";
import { Outlet, RouterLink } from "../../../../plugins";

/** `/ayuda` layout: navigation plus the child page. */
export function HelpLayout(): HTMLElement {
  return div({ class: "help" }, [
    aside([nav([RouterLink({ to: "/ayuda/envios" }, "Envíos")])]),
    main({ class: "help-body" }, [h1("Centro de ayuda"), Outlet()]),
  ]);
}

/** `/ayuda/envios`. */
export function Shipping(): HTMLElement {
  return div({ class: "shipping" }, [h2("Envíos"), p("Entregamos en 48 horas en toda la ciudad.")]);
}
