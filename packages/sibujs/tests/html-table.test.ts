import { describe, expect, it } from "vitest";
import { html, signal } from "../index";

describe("html template table support", () => {
  it("renders table with tr and td", () => {
    const el = html`<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>`;
    expect(el.tagName).toBe("TABLE");
    const rows = el.querySelectorAll("tr");
    expect(rows.length).toBe(2);
    const cells = el.querySelectorAll("td");
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toBe("A1");
    expect(cells[3].textContent).toBe("B2");
  });

  it("renders table with thead and tbody", () => {
    const el = html`<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>`;
    expect(el.tagName).toBe("TABLE");
    expect(el.querySelector("thead")).toBeTruthy();
    expect(el.querySelector("tbody")).toBeTruthy();
    expect(el.querySelector("th")?.textContent).toBe("Header");
    expect(el.querySelector("td")?.textContent).toBe("Cell");
  });

  it("renders table with reactive content", () => {
    const [val, setVal] = signal("hello");
    const el = html`<table><tr><td>${() => val()}</td></tr></table>`;
    expect(el.querySelector("td")?.textContent).toBe("hello");
    setVal("world");
    expect(el.querySelector("td")?.textContent).toBe("world");
  });

  it("renders table with dynamic rows via map", () => {
    const items = ["A", "B", "C"];
    const el = html`<table>${items.map((item) => html`<tr><td>${item}</td></tr>`)}</table>`;
    expect(el.tagName).toBe("TABLE");
    const rows = el.querySelectorAll("tr");
    expect(rows.length).toBe(3);
  });
});
