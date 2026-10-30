import { h1, main, p } from "../../../../index";
import { query } from "../../../../data";
import { fetchStatus } from "../api";

// Records that this module was loaded: the pre-render test checks which page
// modules a build imports (a per-request page's must stay unloaded).
((globalThis as { __sibuFixtureModules?: string[] }).__sibuFixtureModules ??= []).push("status");

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

export default Status;
