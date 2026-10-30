import { a, article, h3, img, p } from "../../../../index";
import type { Product } from "../api";

/** One catalog card. */
export function ProductCard(product: Product): HTMLElement {
  return article({ class: "card", "data-product": product.id }, [
    img({ class: "card-media", src: product.image, alt: product.name, width: "160", height: "160" }),
    h3({ class: "card-title" }, product.name),
    p({ class: "card-price" }, `$${product.price}`),
    a({ class: "card-link", href: `/producto/${product.id}` }, "Ver producto"),
  ]);
}
