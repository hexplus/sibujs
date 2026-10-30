import { h1, main, p } from "../../../../index";

/** `/admin` — browser only, not indexed. */
export function Admin(): HTMLElement {
  return main({ class: "admin" }, [h1("Panel de administración"), p("Pedidos pendientes: 0")]);
}

/** `/mi-cuenta` — needs a session; the guard rejects on the server. */
export function Account(): HTMLElement {
  return main({ class: "account" }, [h1("Mi cuenta")]);
}
