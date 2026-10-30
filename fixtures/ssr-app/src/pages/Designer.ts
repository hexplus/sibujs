import { canvas, h1, main, onMount } from "../../../../index";

/** `/disenador` — canvas + `document.fonts`, browser only (`render: "client"`). */
export function Designer(): HTMLElement {
  const board = canvas({ class: "designer-board", width: "600", height: "400" });
  onMount(() => {
    void document.fonts.ready.then(() => {
      const ctx = (board as HTMLCanvasElement).getContext("2d");
      if (!ctx) return;
      ctx.font = "32px sans-serif";
      ctx.fillText("Tu diseño", 40, 80);
    });
  });
  return main({ class: "designer" }, [h1("Diseñador"), board]);
}
