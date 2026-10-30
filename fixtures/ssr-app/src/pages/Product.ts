import { a, h1, img, main, p, when } from "../../../../index";
import { query } from "../../../../data";
import { route } from "../../../../plugins";
import { fetchProduct } from "../api";

/** `/producto/:id` — one page per catalog id. */
export function ProductPage(): HTMLElement {
  const id = route().params.id;
  const product = query(`/api/catalog/${id}`, ({ signal }) => fetchProduct(id, signal), { staleTime: 60_000 });
  return main({ class: "product" }, [
    when(
      () => product.data(),
      () => {
        const data = product.data();
        if (!data) return p("…");
        return main({ class: "product-detail" }, [
          img({ src: data.image, alt: data.name, width: "320", height: "320" }),
          h1(data.name),
          p({ class: "price" }, `$${data.price}`),
          a({ href: `/cotizar?servicio=dtf&producto=${data.id}` }, "Cotizar este producto"),
        ]);
      },
      () => p({ class: "loading" }, "Cargando producto…"),
    ),
  ]);
}
