import { a, h1, main, p } from "../../../../index";
import { route } from "../../../../plugins";

/** `*` — answers 404. */
export function NotFound(): HTMLElement {
  return main({ class: "not-found" }, [
    h1("Página no encontrada"),
    p(() => `No existe ${route().path}`),
    a({ href: "/" }, "Volver al inicio"),
  ]);
}
