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
export const html = tagFactory("html");
export const head = tagFactory("head");
export const body = tagFactory("body");
export const title = tagFactory("title");

// Content sectioning
export const div = tagFactory("div");
export const span = tagFactory("span");
export const section = tagFactory("section");
export const article = tagFactory("article");
export const header = tagFactory("header");
export const footer = tagFactory("footer");
export const nav = tagFactory("nav");
export const main = tagFactory("main");
export const aside = tagFactory("aside");
export const address = tagFactory("address");

// Text content
export const p = tagFactory("p");
export const h1 = tagFactory("h1");
export const h2 = tagFactory("h2");
export const h3 = tagFactory("h3");
export const h4 = tagFactory("h4");
export const h5 = tagFactory("h5");
export const h6 = tagFactory("h6");
export const blockquote = tagFactory("blockquote");
export const dd = tagFactory("dd");
export const dl = tagFactory("dl");
export const dt = tagFactory("dt");
export const figcaption = tagFactory("figcaption");
export const figure = tagFactory("figure");
export const hr = tagFactory("hr");
export const li = tagFactory("li");
export const ol = tagFactory("ol");
export const ul = tagFactory("ul");
export const pre = tagFactory("pre");

// Inline text semantics
// `a` carries anchor-specific prop types (href, target, rel, etc.)
export const a = tagFactory("a") as unknown as TypedTagFunction<AnchorProps, HTMLAnchorElement>;
export const abbr = tagFactory("abbr");
export const b = tagFactory("b");
export const bdi = tagFactory("bdi");
export const bdo = tagFactory("bdo");
export const br = tagFactory("br");
export const cite = tagFactory("cite");
export const code = tagFactory("code");
export const data = tagFactory("data");
export const dfn = tagFactory("dfn");
export const em = tagFactory("em");
export const i = tagFactory("i");
export const kbd = tagFactory("kbd");
export const mark = tagFactory("mark");
export const q = tagFactory("q");
export const rp = tagFactory("rp");
export const rt = tagFactory("rt");
export const ruby = tagFactory("ruby");
export const s = tagFactory("s");
export const samp = tagFactory("samp");
export const small = tagFactory("small");
export const strong = tagFactory("strong");
export const sub = tagFactory("sub");
export const sup = tagFactory("sup");
export const time = tagFactory("time");
export const u = tagFactory("u");
export const var_ = tagFactory("var"); // 'var' is a reserved keyword

// Image and multimedia
export const area = tagFactory("area");
export const audio = tagFactory("audio") as unknown as TypedTagFunction<AudioProps, HTMLAudioElement>;
export const img = tagFactory("img") as unknown as TypedTagFunction<ImgProps, HTMLImageElement>;
export const map = tagFactory("map");
export const track = tagFactory("track");
export const video = tagFactory("video") as unknown as TypedTagFunction<VideoProps, HTMLVideoElement>;

// Embedded content
export const embed = tagFactory("embed");
export const iframe = tagFactory("iframe");
export const object = tagFactory("object");
export const param = tagFactory("param");
export const picture = tagFactory("picture");
export const portal = tagFactory("portal");
export const source = tagFactory("source");

// SVG and MathML
export const svg = tagFactory("svg", SVG_NS);
export const math = tagFactory("math");

// Scripting
export const canvas = tagFactory("canvas");
export const noscript = tagFactory("noscript");
export const script = tagFactory("script");

// Demarcating edits
export const del = tagFactory("del");
export const ins = tagFactory("ins");

// Table content
export const caption = tagFactory("caption");
export const col = tagFactory("col");
export const colgroup = tagFactory("colgroup");
export const table = tagFactory("table");
export const tbody = tagFactory("tbody");
export const td = tagFactory("td");
export const tfoot = tagFactory("tfoot");
export const th = tagFactory("th");
export const thead = tagFactory("thead");
export const tr = tagFactory("tr");

// Forms — typed factories for the most common elements. All others
// fall back to the untyped `TagProps` for full flexibility.
export const button = tagFactory("button") as unknown as TypedTagFunction<ButtonProps, HTMLButtonElement>;
export const datalist = tagFactory("datalist");
export const fieldset = tagFactory("fieldset");
export const form = tagFactory("form") as unknown as TypedTagFunction<FormProps, HTMLFormElement>;
export const input = tagFactory("input") as unknown as TypedTagFunction<InputProps, HTMLInputElement>;
export const label = tagFactory("label") as unknown as TypedTagFunction<LabelProps, HTMLLabelElement>;
export const legend = tagFactory("legend");
export const meter = tagFactory("meter");
export const optgroup = tagFactory("optgroup");
export const option = tagFactory("option") as unknown as TypedTagFunction<OptionProps, HTMLOptionElement>;
export const output = tagFactory("output");
export const progress = tagFactory("progress");
export const select = tagFactory("select") as unknown as TypedTagFunction<SelectProps, HTMLSelectElement>;
export const textarea = tagFactory("textarea") as unknown as TypedTagFunction<TextareaProps, HTMLTextAreaElement>;

// Interactive elements
export const details = tagFactory("details");
export const dialog = tagFactory("dialog");
export const menu = tagFactory("menu");
export const summary = tagFactory("summary");

// Web Components
export const slot = tagFactory("slot");
export const template = tagFactory("template");

// Document metadata
export const base = tagFactory("base");
export const link = tagFactory("link");
export const meta = tagFactory("meta");
export const style = tagFactory("style");

// Common SVG elements — created with SVG namespace for correct rendering
export const circle = tagFactory("circle", SVG_NS);
export const ellipse = tagFactory("ellipse", SVG_NS);
export const g = tagFactory("g", SVG_NS);
export const line = tagFactory("line", SVG_NS);
export const path = tagFactory("path", SVG_NS);
export const polygon = tagFactory("polygon", SVG_NS);
export const polyline = tagFactory("polyline", SVG_NS);
export const rect = tagFactory("rect", SVG_NS);
export const text = tagFactory("text", SVG_NS);
export const tspan = tagFactory("tspan", SVG_NS);
export const defs = tagFactory("defs", SVG_NS);
export const clipPath = tagFactory("clipPath", SVG_NS);
export const mask = tagFactory("mask", SVG_NS);
export const pattern = tagFactory("pattern", SVG_NS);
export const linearGradient = tagFactory("linearGradient", SVG_NS);
export const radialGradient = tagFactory("radialGradient", SVG_NS);
export const stop = tagFactory("stop", SVG_NS);
export const use = tagFactory("use", SVG_NS);
export const symbol = tagFactory("symbol", SVG_NS);
export const marker = tagFactory("marker", SVG_NS);

// Obsolete/deprecated elements (for legacy support)
export const center = tagFactory("center");
export const font = tagFactory("font");
export const marquee = tagFactory("marquee");

// Custom elements placeholder. Tag name validation (blocking <script>,
// <iframe>, etc.) is enforced inside tagFactory.
export const customElement = (tagName: string) => tagFactory(tagName);
