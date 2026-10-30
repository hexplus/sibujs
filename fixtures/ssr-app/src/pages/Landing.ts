import { div, each, h1, header, main, p, section, when } from "../../../../index";
import { query } from "../../../../data";
import { fetchCatalog } from "../api";
import { ProductCard } from "../components/ProductCard";

/** The catalog query: one key, fresh for a minute (so a transferred copy is not refetched). */
export function catalogQuery() {
  return query("/api/catalog", ({ signal }) => fetchCatalog(signal), { staleTime: 60_000 });
}

/** Marketing landing page: hero plus the product grid from `/api/catalog`. */
export function Landing(): HTMLElement {
  const catalog = catalogQuery();
  return main({ class: "landing" }, [
    header({ class: "hero" }, [
      h1("Personalización textil"),
      p({ class: "lead" }, "Estampado DTF, vinil y bordado con entrega en 48 horas."),
    ]),
    section({ class: "grid", "aria-label": "Productos" }, [
      when(
        () => catalog.data() !== undefined,
        () => div({ class: "cards" }, [each(() => catalog.data() ?? [], (item) => ProductCard(item()), { key: (x) => x.id })]),
        () => p({ class: "loading" }, "Cargando catálogo…"),
      ),
    ]),
  ]);
}
