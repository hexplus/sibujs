import { it } from "vitest";

it("probe", async () => {
  const fd = new FormData();
  fd.append("name", "Ada");
  const out: string[] = [];
  try {
    const r = new Request("https://x.test/a", { method: "POST", body: fd });
    out.push("ct=" + r.headers.get("content-type"));
    const f = await r.clone().formData();
    out.push("formData instanceof global " + (f instanceof FormData) + " get=" + f.get("name"));
  } catch (e) {
    out.push("fd err " + e);
  }
  try {
    const b = new Blob(["hi"], { type: "image/png" });
    const r = new Request("https://x.test/a", { method: "POST", body: b });
    out.push("blob ct=" + r.headers.get("content-type"));
    const bb = await r.clone().blob();
    out.push("blob instanceof " + (bb instanceof Blob) + " size " + bb.size);
  } catch (e) {
    out.push("blob err " + e);
  }
  try {
    const r = new Request("https://x.test/a", { method: "POST", body: new Uint8Array([1, 2]) });
    out.push("buf ct=" + r.headers.get("content-type"));
  } catch (e) {
    out.push("buf err " + e);
  }
  try {
    const r = new Request("https://x.test/a", { method: "POST", body: new URLSearchParams("a=1") });
    out.push("usp ct=" + r.headers.get("content-type"));
  } catch (e) {
    out.push("usp err " + e);
  }
  console.log(out.join("\n"));
});
