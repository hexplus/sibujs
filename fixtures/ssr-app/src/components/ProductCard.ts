import { a, article, canvas, ClientOnly, h3, img, onMount, p } from "../../../../index";
import type { Product } from "../api";

const SIZE = 160;

/** The plain product image: what the server renders, and the first paint. */
function ProductImage(product: Product): HTMLElement {
  return img({ class: "card-media", src: product.image, alt: product.name, width: String(SIZE), height: String(SIZE) });
}

/**
 * The browser version: the same image drawn on a canvas and tinted with the
 * product color. Needs a 2D context, so it only ever runs in a browser.
 */
function RecoloredImage(product: Product): HTMLElement {
  const el = canvas({ class: "card-media", width: String(SIZE), height: String(SIZE), "aria-label": product.name });
  onMount(() => {
    const ctx = (el as HTMLCanvasElement).getContext("2d");
    if (!ctx) return;
    const image = new Image();
    image.onload = () => {
      ctx.drawImage(image, 0, 0, SIZE, SIZE);
      ctx.globalCompositeOperation = "color";
      ctx.fillStyle = product.color;
      ctx.fillRect(0, 0, SIZE, SIZE);
    };
    image.src = product.image;
  });
  return el;
}

/** One catalog card. Same size either way, so the swap does not shift the layout. */
export function ProductCard(product: Product): HTMLElement {
  return article({ class: "card", "data-product": product.id }, [
    ClientOnly(() => RecoloredImage(product), { fallback: () => ProductImage(product) }),
    h3({ class: "card-title" }, product.name),
    p({ class: "card-price" }, `$${product.price}`),
    a({ class: "card-link", href: `/producto/${product.id}` }, "Ver producto"),
  ]);
}
