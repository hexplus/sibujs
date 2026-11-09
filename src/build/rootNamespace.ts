// The namespace object `registerGlobal()` copies onto `window.Sibu`.
//
// It has to be built from this module. A bundler emits a namespace object as a
// top-level `__export(ns, { ... })` call in the chunk that holds the module it
// belongs to, and consumers' bundlers cannot drop that call. Importing
// `../../index` as a namespace put the call in the chunk every client import
// shares, which kept the whole root surface alive: a `signal, div, mount` app
// bundled to 39.9 KB gzip instead of under 15 KB. Only the `sibujs/build` entry
// reaches this module, so here the cost stays with the one caller that needs it.
//
// `tests/dist-tree-shaking.test.ts` pins the result against the built package.
export * from "../../index";
