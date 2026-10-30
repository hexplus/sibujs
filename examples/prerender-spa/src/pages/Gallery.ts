import { div, each, h1, li, signal, ul } from "sibujs";
import { prerenderWait } from "sibujs/ssr";

interface Wrap {
  id: number;
  name: string;
}

// Stands in for a data load. A `fetch()` is awaited by the pre-renderer on its
// own; anything else is registered with prerenderWait() so the static page
// contains the data rather than an empty list.
function loadWraps(): Promise<Wrap[]> {
  return prerenderWait(
    new Promise<Wrap[]>((resolve) =>
      setTimeout(
        () =>
          resolve([
            { id: 1, name: "Matte black pickup" },
            { id: 2, name: "Food truck, full print" },
          ]),
        30,
      ),
    ),
  );
}

export default function Gallery() {
  const [wraps, setWraps] = signal<Wrap[]>([]);
  void loadWraps().then(setWraps);
  return div({ class: "page gallery" }, [
    h1("Gallery"),
    ul([each(() => wraps(), (w) => li(() => w().name), { key: (w) => w.id })]),
  ]);
}
