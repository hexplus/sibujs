# Example: E-Commerce Application

An e-commerce app demonstrating production-ready SibuJS patterns.

## Features

- Normalized data stores for products and cart
- Optimistic updates for cart operations
- Form validation for checkout
- Internationalization (i18n)
- Router with authentication guards
- Plugin system for analytics

## Full Source

### Store Setup

```ts
import { normalizedStore } from "sibujs/performance";
import { signal, derived } from "sibujs";
import { batch } from "sibujs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Product {
  id: string;
  name: string;
  price: number;
  image: string;
  category: string;
}

interface CartItem {
  productId: string;
  quantity: number;
}

// ---------------------------------------------------------------------------
// Normalized Product Store
// ---------------------------------------------------------------------------

const products = normalizedStore<Product>({ name: "product" });

// Seed products
products.addMany([
  { id: "p1", name: "Wireless Headphones", price: 79.99, image: "/img/headphones.jpg", category: "electronics" },
  { id: "p2", name: "Running Shoes", price: 129.99, image: "/img/shoes.jpg", category: "sports" },
  { id: "p3", name: "Coffee Maker", price: 49.99, image: "/img/coffee.jpg", category: "kitchen" },
]);

// ---------------------------------------------------------------------------
// Cart State
// ---------------------------------------------------------------------------

const [cartItems, setCartItems] = signal<CartItem[]>([]);

const cartTotal = derived(() =>
  cartItems().reduce((sum, item) => {
    const product = products.get(item.productId);
    return sum + (product ? product.price * item.quantity : 0);
  }, 0)
);

const cartCount = derived(() =>
  cartItems().reduce((sum, item) => sum + item.quantity, 0)
);

// ---------------------------------------------------------------------------
// Cart Actions (with optimistic updates)
// ---------------------------------------------------------------------------

function addToCart(productId: string) {
  setCartItems((prev) => {
    const existing = prev.find((item) => item.productId === productId);
    if (existing) {
      return prev.map((item) =>
        item.productId === productId
          ? { ...item, quantity: item.quantity + 1 }
          : item
      );
    }
    return [...prev, { productId, quantity: 1 }];
  });
}

function removeFromCart(productId: string) {
  setCartItems((prev) => prev.filter((item) => item.productId !== productId));
}

function updateQuantity(productId: string, quantity: number) {
  if (quantity <= 0) return removeFromCart(productId);
  setCartItems((prev) =>
    prev.map((item) =>
      item.productId === productId ? { ...item, quantity } : item
    )
  );
}
```

### Internationalization

```ts
import { registerTranslations, t, setLocale } from "sibujs/plugins";

registerTranslations("en", {
  "nav.home": "Home",
  "nav.cart": "Cart",
  "product.addToCart": "Add to Cart",
  "cart.total": "Total",
  "cart.checkout": "Checkout",
  "cart.empty": "Your cart is empty",
  "checkout.title": "Checkout",
  "checkout.name": "Full Name",
  "checkout.email": "Email",
  "checkout.submit": "Place Order",
});

registerTranslations("es", {
  "nav.home": "Inicio",
  "nav.cart": "Carrito",
  "product.addToCart": "Agregar al carrito",
  "cart.total": "Total",
  "cart.checkout": "Pagar",
  "cart.empty": "Tu carrito esta vacio",
  "checkout.title": "Pago",
  "checkout.name": "Nombre completo",
  "checkout.email": "Correo electronico",
  "checkout.submit": "Realizar pedido",
});
```

### Analytics Plugin

```ts
import { createPlugin, plugin } from "sibujs/plugins";

const analyticsPlugin = createPlugin("analytics", (ctx) => {
  ctx.onInit(() => {
    console.log("[Analytics] Initialized");
  });

  ctx.onMount((element) => {
    if (element.dataset.track) {
      console.log("[Analytics] Component visible:", element.dataset.track);
    }
  });

  ctx.provide("analytics", {
    track: (event: string, data?: Record<string, any>) => {
      console.log(`[Analytics] ${event}`, data);
    },
  });
});

plugin(analyticsPlugin);
```

### Components

```ts
import {
  div, h1, h2, h3, p, img, button, span, nav, input, form, label,
  mount, each, when,
} from "sibujs";
import { form as createForm, required, email as emailValidator } from "sibujs/ui";
import { Trans } from "sibujs/plugins";

// ---------------------------------------------------------------------------
// Product Card
// ---------------------------------------------------------------------------

function ProductCard(product: Product): HTMLElement {
  return div({
    class: "product-card",
    "data-track": `product-${product.id}`,
  }, [
    img({ src: product.image, alt: product.name, class: "product-image" }),
    div("product-info", [
      h3(product.name),
      p("price", `$${product.price.toFixed(2)}`),
      button({
        class: "btn btn-primary",
        on: { click: () => addToCart(product.id) },
      }, t("product.addToCart")),
    ]),
  ]) as HTMLElement;
}

// ---------------------------------------------------------------------------
// Cart Page
// ---------------------------------------------------------------------------

function CartPage(): HTMLElement {
  return div("page cart-page", [
    h2(Trans("cart.total")),
    when(
      () => cartItems().length === 0,
      () => p(t("cart.empty")) as HTMLElement,
      () =>
        div([
          each(
            () => cartItems(),
            (item) => {
              const data = item();
              const product = products.get(data.productId);
              if (!product) return span("Unknown") as HTMLElement;
              return div("cart-item", [
                span(product.name),
                input({
                  type: "number",
                  value: String(data.quantity),
                  min: "0",
                  on: {
                    change: (e) =>
                      updateQuantity(
                        data.productId,
                        parseInt((e.target as HTMLInputElement).value) || 0
                      ),
                  },
                }),
                span(`$${(product.price * data.quantity).toFixed(2)}`),
                button({
                  on: { click: () => removeFromCart(data.productId) },
                }, "\u00d7"),
              ]) as HTMLElement;
            },
            { key: (item) => item.productId }
          ),
          div("cart-total", () => `${t("cart.total")}: $${cartTotal().toFixed(2)}`),
        ]) as HTMLElement
    ),
  ]) as HTMLElement;
}

// ---------------------------------------------------------------------------
// Checkout Form
// ---------------------------------------------------------------------------

function CheckoutPage(): HTMLElement {
  const { fields, handleSubmit, isValid } = createForm({
    name: { initial: "", validators: [required("Name is required")] },
    email: {
      initial: "",
      validators: [
        required("Email is required"),
        emailValidator("Invalid email"),
      ],
    },
  });

  const onSubmit = handleSubmit((values) => {
    console.log("Order placed:", values, "Items:", cartItems());
    // In production: send to API, handle response
  });

  return form({
    class: "checkout-form",
    on: { submit: onSubmit },
  }, [
    h2(t("checkout.title")),
    div("form-field", [
      label(t("checkout.name")),
      input({
        type: "text",
        value: () => fields.name.value(),
        on: {
          input: (e) => fields.name.set((e.target as HTMLInputElement).value),
          blur: () => fields.name.touch(),
        },
      }),
      when(
        () => fields.name.touched() && fields.name.error() !== null,
        () => span({ class: "error" }, () => fields.name.error()!) as HTMLElement
      ),
    ]),
    div("form-field", [
      label(t("checkout.email")),
      input({
        type: "email",
        value: () => fields.email.value(),
        on: {
          input: (e) => fields.email.set((e.target as HTMLInputElement).value),
          blur: () => fields.email.touch(),
        },
      }),
      when(
        () => fields.email.touched() && fields.email.error() !== null,
        () => span({ class: "error" }, () => fields.email.error()!) as HTMLElement
      ),
    ]),
    button({
      type: "submit",
      class: () => `btn btn-primary ${isValid() ? "" : "disabled"}`,
    }, t("checkout.submit")),
  ]) as HTMLElement;
}
```

### Router with Guards

```ts
import { createRouter, RouterLink, Route, Outlet } from "sibujs/plugins";

const [isAuthenticated, setAuthenticated] = signal(true);

const router = createRouter([
  { path: "/", component: () => ProductListPage() },
  { path: "/cart", component: () => CartPage() },
  {
    path: "/checkout",
    component: () => CheckoutPage(),
    beforeEnter: (to) => {
      if (!isAuthenticated()) return "/login";
      if (cartItems().length === 0) return "/cart";
      return true;
    },
  },
], { mode: "history" });
```

### App Shell

```ts
function ProductListPage(): HTMLElement {
  const [category, setCategory] = signal<string | null>(null);

  const filtered = derived(() => {
    const cat = category();
    const all = products.getAll();
    return cat ? all.filter((p) => p.category === cat) : all;
  });

  return div("page", [
    h1("Products"),
    div("filters", ["all", "electronics", "sports", "kitchen"].map((cat) =>
      button({
        class: () =>
          `filter-btn ${(cat === "all" ? null : cat) === category() ? "active" : ""}`,
        on: { click: () => setCategory(cat === "all" ? null : cat) },
      }, cat)
    )),
    div("product-grid", [
      each(
        () => filtered(),
        (product) => ProductCard(product()),
        { key: (p) => p.id }
      ),
    ]),
  ]) as HTMLElement;
}

function AppNav(): HTMLElement {
  return nav("main-nav", [
    RouterLink({ to: "/", nodes: t("nav.home") }),
    RouterLink({ to: "/cart", nodes: () => `${t("nav.cart")} (${cartCount()})` }),
    button({
      on: {
        click: () => setLocale(t("nav.home") === "Home" ? "es" : "en"),
      },
    }, "EN/ES"),
  ]) as HTMLElement;
}

function App(): HTMLElement {
  return div("app", [AppNav(), Outlet()]) as HTMLElement;
}

mount(App, document.getElementById("app"));
```

## Key Patterns Demonstrated

| Pattern | Usage |
|---------|-------|
| `normalizedStore` | Product catalog with O(1) lookups |
| `form` with validators | Checkout form with `required` and `email` validation |
| `derived` | Cart total, cart count, filtered products |
| `each()` with key | Product grid, cart items list |
| `when()` | Empty cart message, form validation errors |
| `createRouter` with guards | Authentication + empty-cart guard on checkout |
| `registerTranslations` + `t()` | English/Spanish translations |
| `createPlugin` | Analytics tracking plugin |
| `batch()` | Coordinated cart + UI updates |
