import { figure, h1, main, section } from "../../../../index";

/** `/galeria` — loaded lazily. */
export default function Gallery(): HTMLElement {
  return main({ class: "gallery" }, [
    h1("Galería de trabajos"),
    section({ class: "gallery-grid" }, [figure("Uniformes escolares"), figure("Merch para eventos")]),
  ]);
}
