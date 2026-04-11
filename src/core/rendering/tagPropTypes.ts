// ============================================================================
// TYPED TAG FACTORY PROPS
// ============================================================================
//
// SibuJS tag factories currently take `TagProps` which has a catch-all
// `[attr: string]: unknown` index signature. That guarantees zero friction
// for custom elements and data-* attributes, but it hides typos and
// disables autocomplete on the most common elements (`a`, `input`, `img`,
// `button`, `form`, `select`, `textarea`, `label`, `option`, `video`,
// `audio`).
//
// This module defines per-element prop interfaces as a pure-type overlay.
// `html.ts` then re-declares those specific factories with stronger
// types, so callers writing `a({ href: "/home", target: "_blank" })`
// get IntelliSense and typo detection for free.
//
// Zero runtime change — this file has no runtime exports.

import type { TagProps } from "./tagFactory";

// ─── Reactive-or-literal helper ──────────────────────────────────────────
// Most props accept either a static value or a reactive getter. Helpers
// like `reactive<string>` keep the individual prop definitions readable.
type reactive<T> = T | (() => T);

// ─── Anchor ──────────────────────────────────────────────────────────────

export interface AnchorProps extends TagProps {
  href?: reactive<string>;
  target?: "_self" | "_blank" | "_parent" | "_top" | (string & {});
  rel?: reactive<string>;
  download?: reactive<string | boolean>;
  hreflang?: reactive<string>;
  referrerpolicy?: reactive<
    | ""
    | "no-referrer"
    | "no-referrer-when-downgrade"
    | "origin"
    | "origin-when-cross-origin"
    | "same-origin"
    | "strict-origin"
    | "strict-origin-when-cross-origin"
    | "unsafe-url"
  >;
  ping?: reactive<string>;
}

// ─── Input ───────────────────────────────────────────────────────────────

export type InputType =
  | "button"
  | "checkbox"
  | "color"
  | "date"
  | "datetime-local"
  | "email"
  | "file"
  | "hidden"
  | "image"
  | "month"
  | "number"
  | "password"
  | "radio"
  | "range"
  | "reset"
  | "search"
  | "submit"
  | "tel"
  | "text"
  | "time"
  | "url"
  | "week";

export interface InputProps extends TagProps {
  type?: InputType | (string & {});
  name?: reactive<string>;
  value?: reactive<string | number>;
  placeholder?: reactive<string>;
  required?: reactive<boolean>;
  disabled?: reactive<boolean>;
  readonly?: reactive<boolean>;
  checked?: reactive<boolean>;
  min?: reactive<string | number>;
  max?: reactive<string | number>;
  step?: reactive<string | number>;
  minlength?: reactive<number>;
  maxlength?: reactive<number>;
  pattern?: reactive<string>;
  autocomplete?: reactive<string>;
  autofocus?: reactive<boolean>;
  multiple?: reactive<boolean>;
  accept?: reactive<string>;
  size?: reactive<number>;
  form?: reactive<string>;
  list?: reactive<string>;
  inputmode?: reactive<"none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url">;
}

// ─── Image ───────────────────────────────────────────────────────────────

export interface ImgProps extends TagProps {
  src?: reactive<string>;
  alt?: reactive<string>;
  width?: reactive<number | string>;
  height?: reactive<number | string>;
  loading?: reactive<"lazy" | "eager">;
  decoding?: reactive<"sync" | "async" | "auto">;
  srcset?: reactive<string>;
  sizes?: reactive<string>;
  crossorigin?: reactive<"anonymous" | "use-credentials">;
  referrerpolicy?: reactive<string>;
}

// ─── Button ──────────────────────────────────────────────────────────────

export interface ButtonProps extends TagProps {
  type?: reactive<"button" | "submit" | "reset">;
  name?: reactive<string>;
  value?: reactive<string>;
  disabled?: reactive<boolean>;
  form?: reactive<string>;
  formaction?: reactive<string>;
  formenctype?: reactive<string>;
  formmethod?: reactive<"get" | "post" | "dialog">;
  formnovalidate?: reactive<boolean>;
  formtarget?: reactive<string>;
  autofocus?: reactive<boolean>;
}

// ─── Form ────────────────────────────────────────────────────────────────

export interface FormProps extends TagProps {
  action?: reactive<string>;
  method?: reactive<"get" | "post" | "dialog">;
  enctype?: reactive<"application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain">;
  name?: reactive<string>;
  novalidate?: reactive<boolean>;
  target?: reactive<string>;
  autocomplete?: reactive<"on" | "off">;
  acceptcharset?: reactive<string>;
}

// ─── Select ──────────────────────────────────────────────────────────────

export interface SelectProps extends TagProps {
  name?: reactive<string>;
  value?: reactive<string>;
  disabled?: reactive<boolean>;
  multiple?: reactive<boolean>;
  required?: reactive<boolean>;
  size?: reactive<number>;
  autocomplete?: reactive<string>;
  autofocus?: reactive<boolean>;
  form?: reactive<string>;
}

// ─── Textarea ────────────────────────────────────────────────────────────

export interface TextareaProps extends TagProps {
  name?: reactive<string>;
  value?: reactive<string>;
  placeholder?: reactive<string>;
  disabled?: reactive<boolean>;
  readonly?: reactive<boolean>;
  required?: reactive<boolean>;
  rows?: reactive<number>;
  cols?: reactive<number>;
  minlength?: reactive<number>;
  maxlength?: reactive<number>;
  wrap?: reactive<"hard" | "soft" | "off">;
  autocomplete?: reactive<string>;
  autofocus?: reactive<boolean>;
  form?: reactive<string>;
  spellcheck?: reactive<boolean>;
}

// ─── Label ───────────────────────────────────────────────────────────────

export interface LabelProps extends TagProps {
  for?: reactive<string>;
  form?: reactive<string>;
}

// ─── Option / Optgroup ───────────────────────────────────────────────────

export interface OptionProps extends TagProps {
  value?: reactive<string | number>;
  selected?: reactive<boolean>;
  disabled?: reactive<boolean>;
  label?: reactive<string>;
}

// ─── Video / Audio ───────────────────────────────────────────────────────

export interface MediaProps extends TagProps {
  src?: reactive<string>;
  autoplay?: reactive<boolean>;
  controls?: reactive<boolean>;
  loop?: reactive<boolean>;
  muted?: reactive<boolean>;
  preload?: reactive<"none" | "metadata" | "auto">;
  crossorigin?: reactive<"anonymous" | "use-credentials">;
}

export interface VideoProps extends MediaProps {
  poster?: reactive<string>;
  width?: reactive<number | string>;
  height?: reactive<number | string>;
  playsinline?: reactive<boolean>;
}

export type AudioProps = MediaProps;

// ─── Unified factory signature ───────────────────────────────────────────
//
// A typed tag function takes element-specific props (or the generic
// children shorthand) and returns the matching DOM element subclass.
// The `T` type parameter carries the element class so callers that need
// imperative access get the specific `HTMLInputElement` etc. without a
// cast.

import type { NodeChildren } from "./types";

export type TypedTagFunction<Props extends TagProps, El extends Element> = (
  first?: Props | NodeChildren,
  second?: NodeChildren,
) => El;
