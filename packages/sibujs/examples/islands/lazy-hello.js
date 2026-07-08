// A lazily-loaded island module. Fetched by the browser only when its island
// activates (see examples/islands-lazy.html). Its default export is an
// `enhance` setup — it receives the EnhanceContext and drives the server markup
// in place. No imports needed; everything comes from `ctx`.
export default function helloIsland(ctx) {
  let clicks = 0;
  ctx.text("@v", () => `lazy-loaded (${clicks})`);
  ctx.on("@v", "click", () => {
    clicks++;
    // re-run the text binding by toggling a no-op attribute is unnecessary —
    // for a non-reactive counter we just write directly:
    const el = ctx.ref("@v");
    if (el) el.textContent = `lazy-loaded (${clicks})`;
  });
}
