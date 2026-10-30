// Option 2: progressive enhancement of backend-rendered HTML. Bundle this file
// alone (`vite build --lib`, or any bundler) and include it from the template.
import { mountIslands, registerIsland, signal } from "sibujs";

registerIsland("quote", (ctx) => {
  const [count, setCount] = signal(0);
  ctx.on("#q-name", "input", (e) => setCount((e.target as HTMLInputElement).value.length));
  ctx.text("[data-sibu=count]", () => String(count()));
});

mountIslands(document);
