import { button, form, h1, input, label, main, option, p, select, textarea } from "../../../../index";
import { route } from "../../../../plugins";

const SERVICES = [
  ["dtf", "Estampado DTF"],
  ["vinil", "Vinil textil"],
  ["bordado", "Bordado"],
] as const;

/** `/cotizar?servicio=dtf` — a quote form preselected from the query. */
export function Quote(): HTMLElement {
  const selected = route().query.servicio ?? "dtf";
  return main({ class: "quote" }, [
    h1("Cotiza tu pedido"),
    p({ class: "service" }, () => `Servicio: ${route().query.servicio ?? "sin elegir"}`),
    form({ class: "quote-form", method: "post", action: "/api/quote" }, [
      label({ for: "quote-name" }, "Nombre"),
      input({ id: "quote-name", name: "name", type: "text", autocomplete: "name" }),
      label({ for: "quote-service" }, "Servicio"),
      select(
        { id: "quote-service", name: "service" },
        SERVICES.map(([value, text]) => option(value === selected ? { value, selected: true } : { value }, text)),
      ),
      label({ for: "quote-notes" }, "Detalles"),
      textarea({ id: "quote-notes", name: "notes", rows: 4 }),
      button({ type: "submit" }, "Enviar"),
    ]),
  ]);
}
