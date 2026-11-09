import { SVG_NS, tagFactory } from "./tagFactory";
import type {
  AnchorProps,
  AudioProps,
  ButtonProps,
  FormProps,
  ImgProps,
  InputProps,
  LabelProps,
  OptionProps,
  SelectProps,
  TextareaProps,
  TypedTagFunction,
  VideoProps,
} from "./tagPropTypes";

// Document structure
export const html = /* @__PURE__ */ tagFactory("html");
export const head = /* @__PURE__ */ tagFactory("head");
export const body = /* @__PURE__ */ tagFactory("body");
export const title = /* @__PURE__ */ tagFactory("title");

// Content sectioning
export const div = /* @__PURE__ */ tagFactory("div");
export const span = /* @__PURE__ */ tagFactory("span");
export const section = /* @__PURE__ */ tagFactory("section");
export const article = /* @__PURE__ */ tagFactory("article");
export const header = /* @__PURE__ */ tagFactory("header");
export const footer = /* @__PURE__ */ tagFactory("footer");
export const nav = /* @__PURE__ */ tagFactory("nav");
export const main = /* @__PURE__ */ tagFactory("main");
export const aside = /* @__PURE__ */ tagFactory("aside");
export const address = /* @__PURE__ */ tagFactory("address");

// Text content
export const p = /* @__PURE__ */ tagFactory("p");
export const h1 = /* @__PURE__ */ tagFactory("h1");
export const h2 = /* @__PURE__ */ tagFactory("h2");
export const h3 = /* @__PURE__ */ tagFactory("h3");
export const h4 = /* @__PURE__ */ tagFactory("h4");
export const h5 = /* @__PURE__ */ tagFactory("h5");
export const h6 = /* @__PURE__ */ tagFactory("h6");
export const blockquote = /* @__PURE__ */ tagFactory("blockquote");
export const dd = /* @__PURE__ */ tagFactory("dd");
export const dl = /* @__PURE__ */ tagFactory("dl");
export const dt = /* @__PURE__ */ tagFactory("dt");
export const figcaption = /* @__PURE__ */ tagFactory("figcaption");
export const figure = /* @__PURE__ */ tagFactory("figure");
export const hr = /* @__PURE__ */ tagFactory("hr");
export const li = /* @__PURE__ */ tagFactory("li");
export const ol = /* @__PURE__ */ tagFactory("ol");
export const ul = /* @__PURE__ */ tagFactory("ul");
export const pre = /* @__PURE__ */ tagFactory("pre");

// Inline text semantics
// `a` carries anchor-specific prop types (href, target, rel, etc.)
export const a: TypedTagFunction<AnchorProps, HTMLAnchorElement> = /* @__PURE__ */ tagFactory("a");
export const abbr = /* @__PURE__ */ tagFactory("abbr");
export const b = /* @__PURE__ */ tagFactory("b");
export const bdi = /* @__PURE__ */ tagFactory("bdi");
export const bdo = /* @__PURE__ */ tagFactory("bdo");
export const br = /* @__PURE__ */ tagFactory("br");
export const cite = /* @__PURE__ */ tagFactory("cite");
export const code = /* @__PURE__ */ tagFactory("code");
export const data = /* @__PURE__ */ tagFactory("data");
export const dfn = /* @__PURE__ */ tagFactory("dfn");
export const em = /* @__PURE__ */ tagFactory("em");
export const i = /* @__PURE__ */ tagFactory("i");
export const kbd = /* @__PURE__ */ tagFactory("kbd");
export const mark = /* @__PURE__ */ tagFactory("mark");
export const q = /* @__PURE__ */ tagFactory("q");
export const rp = /* @__PURE__ */ tagFactory("rp");
export const rt = /* @__PURE__ */ tagFactory("rt");
export const ruby = /* @__PURE__ */ tagFactory("ruby");
export const s = /* @__PURE__ */ tagFactory("s");
export const samp = /* @__PURE__ */ tagFactory("samp");
export const small = /* @__PURE__ */ tagFactory("small");
export const strong = /* @__PURE__ */ tagFactory("strong");
export const sub = /* @__PURE__ */ tagFactory("sub");
export const sup = /* @__PURE__ */ tagFactory("sup");
export const time = /* @__PURE__ */ tagFactory("time");
export const u = /* @__PURE__ */ tagFactory("u");
export const var_ = /* @__PURE__ */ tagFactory("var"); // 'var' is a reserved keyword

// Image and multimedia
export const area = /* @__PURE__ */ tagFactory("area");
export const audio: TypedTagFunction<AudioProps, HTMLAudioElement> = /* @__PURE__ */ tagFactory("audio");
export const img: TypedTagFunction<ImgProps, HTMLImageElement> = /* @__PURE__ */ tagFactory("img");
export const map = /* @__PURE__ */ tagFactory("map");
export const track = /* @__PURE__ */ tagFactory("track");
export const video: TypedTagFunction<VideoProps, HTMLVideoElement> = /* @__PURE__ */ tagFactory("video");

// Embedded content
export const embed = /* @__PURE__ */ tagFactory("embed");
export const iframe = /* @__PURE__ */ tagFactory("iframe");
export const object = /* @__PURE__ */ tagFactory("object");
export const param = /* @__PURE__ */ tagFactory("param");
export const picture = /* @__PURE__ */ tagFactory("picture");
export const portal = /* @__PURE__ */ tagFactory("portal");
export const source = /* @__PURE__ */ tagFactory("source");

// SVG and MathML
export const svg = /* @__PURE__ */ tagFactory("svg", SVG_NS);
export const math = /* @__PURE__ */ tagFactory("math");

// Scripting
export const canvas = /* @__PURE__ */ tagFactory("canvas");
export const noscript = /* @__PURE__ */ tagFactory("noscript");
export const script = /* @__PURE__ */ tagFactory("script");

// Demarcating edits
export const del = /* @__PURE__ */ tagFactory("del");
export const ins = /* @__PURE__ */ tagFactory("ins");

// Table content
export const caption = /* @__PURE__ */ tagFactory("caption");
export const col = /* @__PURE__ */ tagFactory("col");
export const colgroup = /* @__PURE__ */ tagFactory("colgroup");
export const table = /* @__PURE__ */ tagFactory("table");
export const tbody = /* @__PURE__ */ tagFactory("tbody");
export const td = /* @__PURE__ */ tagFactory("td");
export const tfoot = /* @__PURE__ */ tagFactory("tfoot");
export const th = /* @__PURE__ */ tagFactory("th");
export const thead = /* @__PURE__ */ tagFactory("thead");
export const tr = /* @__PURE__ */ tagFactory("tr");

// Forms — the most common elements also get per-element prop types. All
// others take the generic `TagProps`; every factory returns its specific
// element type either way.
export const button: TypedTagFunction<ButtonProps, HTMLButtonElement> = /* @__PURE__ */ tagFactory("button");
export const datalist = /* @__PURE__ */ tagFactory("datalist");
export const fieldset = /* @__PURE__ */ tagFactory("fieldset");
export const form: TypedTagFunction<FormProps, HTMLFormElement> = /* @__PURE__ */ tagFactory("form");
export const input: TypedTagFunction<InputProps, HTMLInputElement> = /* @__PURE__ */ tagFactory("input");
export const label: TypedTagFunction<LabelProps, HTMLLabelElement> = /* @__PURE__ */ tagFactory("label");
export const legend = /* @__PURE__ */ tagFactory("legend");
export const meter = /* @__PURE__ */ tagFactory("meter");
export const optgroup = /* @__PURE__ */ tagFactory("optgroup");
export const option: TypedTagFunction<OptionProps, HTMLOptionElement> = /* @__PURE__ */ tagFactory("option");
export const output = /* @__PURE__ */ tagFactory("output");
export const progress = /* @__PURE__ */ tagFactory("progress");
export const select: TypedTagFunction<SelectProps, HTMLSelectElement> = /* @__PURE__ */ tagFactory("select");
export const textarea: TypedTagFunction<TextareaProps, HTMLTextAreaElement> = /* @__PURE__ */ tagFactory("textarea");

// Interactive elements
export const details = /* @__PURE__ */ tagFactory("details");
export const dialog = /* @__PURE__ */ tagFactory("dialog");
export const menu = /* @__PURE__ */ tagFactory("menu");
export const summary = /* @__PURE__ */ tagFactory("summary");

// Web Components
export const slot = /* @__PURE__ */ tagFactory("slot");
export const template = /* @__PURE__ */ tagFactory("template");

// Document metadata
export const base = /* @__PURE__ */ tagFactory("base");
export const link = /* @__PURE__ */ tagFactory("link");
export const meta = /* @__PURE__ */ tagFactory("meta");
/**
 * `<style>`. Its text is STYLESHEET SOURCE, applied unsanitized exactly like a
 * stylesheet shipped with the application — a trust boundary, since a tag
 * factory cannot tell a literal from runtime data. For CSS that comes from
 * runtime data use `scopedStyle()` (sanitized stylesheet text) or `style` props
 * (sanitized per declaration).
 */
export const style = /* @__PURE__ */ tagFactory("style");

// Common SVG elements — created with SVG namespace for correct rendering
export const circle = /* @__PURE__ */ tagFactory("circle", SVG_NS);
export const ellipse = /* @__PURE__ */ tagFactory("ellipse", SVG_NS);
export const g = /* @__PURE__ */ tagFactory("g", SVG_NS);
export const line = /* @__PURE__ */ tagFactory("line", SVG_NS);
export const path = /* @__PURE__ */ tagFactory("path", SVG_NS);
export const polygon = /* @__PURE__ */ tagFactory("polygon", SVG_NS);
export const polyline = /* @__PURE__ */ tagFactory("polyline", SVG_NS);
export const rect = /* @__PURE__ */ tagFactory("rect", SVG_NS);
export const text = /* @__PURE__ */ tagFactory("text", SVG_NS);
export const tspan = /* @__PURE__ */ tagFactory("tspan", SVG_NS);
export const defs = /* @__PURE__ */ tagFactory("defs", SVG_NS);
export const clipPath = /* @__PURE__ */ tagFactory("clipPath", SVG_NS);
export const mask = /* @__PURE__ */ tagFactory("mask", SVG_NS);
export const pattern = /* @__PURE__ */ tagFactory("pattern", SVG_NS);
export const linearGradient = /* @__PURE__ */ tagFactory("linearGradient", SVG_NS);
export const radialGradient = /* @__PURE__ */ tagFactory("radialGradient", SVG_NS);
export const stop = /* @__PURE__ */ tagFactory("stop", SVG_NS);
export const use = /* @__PURE__ */ tagFactory("use", SVG_NS);
export const symbol = /* @__PURE__ */ tagFactory("symbol", SVG_NS);
export const marker = /* @__PURE__ */ tagFactory("marker", SVG_NS);

// Obsolete/deprecated elements (for legacy support)
export const center = /* @__PURE__ */ tagFactory("center");
export const font = /* @__PURE__ */ tagFactory("font");
export const marquee = /* @__PURE__ */ tagFactory("marquee");

// Custom elements placeholder. Tag name validation (blocking <script>,
// <iframe>, etc.) is enforced inside tagFactory.
export const customElement = (tagName: string) => tagFactory(tagName);
