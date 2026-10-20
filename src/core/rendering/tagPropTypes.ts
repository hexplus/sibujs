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

import type { TagFunction, TagProps } from "./tagFactory";

// ─── Reactive-or-literal helpers ─────────────────────────────────────────
// Most props accept either a static value or a reactive getter. Helpers
// like `attr<string>` keep the individual prop definitions readable.
//
// `attr<T>` is an ATTRIBUTE: its getter may resolve to `null` / `undefined`,
// which removes the attribute (the runtime has done so since 4.5; the types
// caught up in 4.12). `attr<T>` is kept for the IDL properties — `value`,
// `checked`, `selected`, `disabled` — which are DOM state written as
// properties, not optional attributes.
type reactive<T> = T | (() => T);
type attr<T> = T | (() => T | null | undefined);

// ─── Anchor ──────────────────────────────────────────────────────────────

export interface AnchorProps extends TagProps<HTMLAnchorElement> {
  href?: attr<string>;
  target?: attr<"_self" | "_blank" | "_parent" | "_top" | (string & {})>;
  rel?: attr<string>;
  download?: attr<string | boolean>;
  hreflang?: attr<string>;
  referrerpolicy?: attr<
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
  ping?: attr<string>;
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

export interface InputProps extends TagProps<HTMLInputElement> {
  type?: attr<InputType | (string & {})>;
  name?: attr<string>;
  value?: reactive<string | number>;
  placeholder?: attr<string>;
  required?: attr<boolean>;
  disabled?: reactive<boolean>;
  readonly?: attr<boolean>;
  checked?: reactive<boolean>;
  min?: attr<string | number>;
  max?: attr<string | number>;
  step?: attr<string | number>;
  minlength?: attr<number>;
  maxlength?: attr<number>;
  pattern?: attr<string>;
  autocomplete?: attr<string>;
  autofocus?: attr<boolean>;
  multiple?: attr<boolean>;
  accept?: attr<string>;
  size?: attr<number>;
  form?: attr<string>;
  list?: attr<string>;
  inputmode?: attr<"none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url">;
}

// ─── Image ───────────────────────────────────────────────────────────────

export interface ImgProps extends TagProps<HTMLImageElement> {
  src?: attr<string>;
  alt?: attr<string>;
  width?: attr<number | string>;
  height?: attr<number | string>;
  loading?: attr<"lazy" | "eager">;
  decoding?: attr<"sync" | "async" | "auto">;
  srcset?: attr<string>;
  sizes?: attr<string>;
  crossorigin?: attr<"anonymous" | "use-credentials">;
  referrerpolicy?: attr<string>;
}

// ─── Button ──────────────────────────────────────────────────────────────

export interface ButtonProps extends TagProps<HTMLButtonElement> {
  type?: attr<"button" | "submit" | "reset">;
  name?: attr<string>;
  value?: reactive<string>;
  disabled?: reactive<boolean>;
  form?: attr<string>;
  formaction?: attr<string>;
  formenctype?: attr<string>;
  formmethod?: attr<"get" | "post" | "dialog">;
  formnovalidate?: attr<boolean>;
  formtarget?: attr<string>;
  autofocus?: attr<boolean>;
}

// ─── Form ────────────────────────────────────────────────────────────────

export interface FormProps extends TagProps<HTMLFormElement> {
  action?: attr<string>;
  method?: attr<"get" | "post" | "dialog">;
  enctype?: attr<"application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain">;
  name?: attr<string>;
  novalidate?: attr<boolean>;
  target?: attr<string>;
  autocomplete?: attr<"on" | "off">;
  acceptcharset?: attr<string>;
}

// ─── Select ──────────────────────────────────────────────────────────────

export interface SelectProps extends TagProps<HTMLSelectElement> {
  name?: attr<string>;
  value?: reactive<string>;
  disabled?: reactive<boolean>;
  multiple?: attr<boolean>;
  required?: attr<boolean>;
  size?: attr<number>;
  autocomplete?: attr<string>;
  autofocus?: attr<boolean>;
  form?: attr<string>;
}

// ─── Textarea ────────────────────────────────────────────────────────────

export interface TextareaProps extends TagProps<HTMLTextAreaElement> {
  name?: attr<string>;
  value?: reactive<string>;
  placeholder?: attr<string>;
  disabled?: reactive<boolean>;
  readonly?: attr<boolean>;
  required?: attr<boolean>;
  rows?: attr<number>;
  cols?: attr<number>;
  minlength?: attr<number>;
  maxlength?: attr<number>;
  wrap?: attr<"hard" | "soft" | "off">;
  autocomplete?: attr<string>;
  autofocus?: attr<boolean>;
  form?: attr<string>;
  spellcheck?: attr<boolean>;
}

// ─── Label ───────────────────────────────────────────────────────────────

export interface LabelProps extends TagProps<HTMLLabelElement> {
  for?: attr<string>;
  form?: attr<string>;
}

// ─── Option / Optgroup ───────────────────────────────────────────────────

export interface OptionProps extends TagProps<HTMLOptionElement> {
  value?: reactive<string | number>;
  selected?: reactive<boolean>;
  disabled?: reactive<boolean>;
  label?: attr<string>;
}

// ─── Video / Audio ───────────────────────────────────────────────────────

export interface MediaProps<El extends HTMLMediaElement = HTMLMediaElement> extends TagProps<El> {
  src?: attr<string>;
  autoplay?: attr<boolean>;
  controls?: attr<boolean>;
  loop?: attr<boolean>;
  muted?: attr<boolean>;
  preload?: attr<"none" | "metadata" | "auto">;
  crossorigin?: attr<"anonymous" | "use-credentials">;
}

export interface VideoProps extends MediaProps<HTMLVideoElement> {
  poster?: attr<string>;
  width?: attr<number | string>;
  height?: attr<number | string>;
  playsinline?: attr<boolean>;
}

export type AudioProps = MediaProps<HTMLAudioElement>;

// ─── Unified factory signature ───────────────────────────────────────────
//
// A typed tag function takes element-specific props (or the generic
// children shorthand) and returns the matching DOM element subclass.
// The `El` type parameter carries the element class so callers that need
// imperative access get the specific `HTMLInputElement` etc. without a
// cast. Same shape as `TagFunction`, with the props type first.

export type TypedTagFunction<Props extends TagProps<El>, El extends Element> = TagFunction<El, Props>;
