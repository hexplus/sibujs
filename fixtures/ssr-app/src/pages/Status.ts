import { h1, main, p } from "../../../../index";
import { query } from "../../../../data";
import { fetchStatus } from "../api";

/** `/estado` — per-request status page (`render: "ssr"`). */
export function Status(): HTMLElement {
  const status = query("/api/status", ({ signal }) => fetchStatus(signal));
  return main({ class: "status" }, [
    h1("Estado del servicio"),
    p({ class: "status-line" }, () => {
      const s = status.data();
      return s ? `${s.ok ? "Operativo" : "Con fallas"} (${s.checkedAt})` : "Comprobando…";
    }),
  ]);
}
