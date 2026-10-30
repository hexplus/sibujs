import { figure, h1, main, section } from "../../../../index";

// Records that this module was loaded: the pre-render test checks which page
// modules a build imports (a per-request page's must stay unloaded).
((globalThis as { __sibuFixtureModules?: string[] }).__sibuFixtureModules ??= []).push("gallery");

/** `/galeria` — loaded lazily. */
export default function Gallery(): HTMLElement {
  return main({ class: "gallery" }, [
    h1("Galería de trabajos"),
    section({ class: "gallery-grid" }, [figure("Uniformes escolares"), figure("Merch para eventos")]),
  ]);
}
