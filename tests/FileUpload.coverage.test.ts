import { describe, expect, it, vi } from "vitest";
import { fileUpload } from "../src/widgets/FileUpload";

function makeFile(name: string, size: number, type = "text/plain"): File {
  const file = new File(["x".repeat(size)], name, { type });
  // jsdom does not always honor the size from content, force it.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function makeFileList(files: File[]): FileList {
  const list = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      for (const f of files) yield f;
    },
  } as unknown as FileList;
  for (let i = 0; i < files.length; i++) {
    (list as unknown as Record<number, File>)[i] = files[i];
  }
  return list;
}

describe("fileUpload coverage", () => {
  it("addFiles accepts files and calls onFiles", () => {
    const onFiles = vi.fn();
    const fu = fileUpload({ multiple: true, onFiles });
    fu.addFiles([makeFile("a.txt", 10), makeFile("b.txt", 20)]);
    expect(fu.files().length).toBe(2);
    expect(onFiles).toHaveBeenCalledOnce();
    expect(fu.errors()).toEqual([]);
  });

  it("single mode keeps only the last valid file", () => {
    const fu = fileUpload();
    fu.addFiles([makeFile("a.txt", 10), makeFile("b.txt", 20)]);
    expect(fu.files().length).toBe(1);
    expect(fu.files()[0].name).toBe("b.txt");
  });

  it("rejects files exceeding maxSize", () => {
    const fu = fileUpload({ maxSize: 50 });
    fu.addFiles([makeFile("big.txt", 100)]);
    expect(fu.files().length).toBe(0);
    expect(fu.errors()[0]).toContain("exceeds maximum size");
  });

  it("rejects files not matching extension accept", () => {
    const fu = fileUpload({ accept: ".png,.jpg" });
    fu.addFiles([makeFile("doc.txt", 10)]);
    expect(fu.files().length).toBe(0);
    expect(fu.errors()[0]).toContain("not an accepted type");
  });

  it("accepts wildcard mime type", () => {
    const fu = fileUpload({ accept: "image/*", multiple: true });
    fu.addFiles([makeFile("p.png", 10, "image/png"), makeFile("d.txt", 10, "text/plain")]);
    expect(fu.files().length).toBe(1);
    expect(fu.files()[0].name).toBe("p.png");
  });

  it("accepts exact mime type", () => {
    const fu = fileUpload({ accept: "application/pdf" });
    fu.addFiles([makeFile("f.pdf", 10, "application/pdf")]);
    expect(fu.files().length).toBe(1);
  });

  it("removeFile removes by index and ignores out of range", () => {
    const fu = fileUpload({ multiple: true });
    fu.addFiles([makeFile("a.txt", 1), makeFile("b.txt", 1), makeFile("c.txt", 1)]);
    fu.removeFile(1);
    expect(fu.files().map((f) => f.name)).toEqual(["a.txt", "c.txt"]);
    fu.removeFile(99);
    fu.removeFile(-1);
    expect(fu.files().length).toBe(2);
  });

  it("clear resets files and errors", () => {
    const fu = fileUpload({ maxSize: 5 });
    fu.addFiles([makeFile("big.txt", 100)]);
    expect(fu.errors().length).toBe(1);
    fu.clear();
    expect(fu.files().length).toBe(0);
    expect(fu.errors().length).toBe(0);
  });

  it("setDragOver / isDragOver toggle", () => {
    const fu = fileUpload();
    expect(fu.isDragOver()).toBe(false);
    fu.setDragOver(true);
    expect(fu.isDragOver()).toBe(true);
  });

  it("bind wires aria attributes, change, hint and error region", () => {
    const fu = fileUpload({ accept: ".txt", multiple: true });
    const input = document.createElement("input");
    input.type = "file";
    const dropZone = document.createElement("div");
    const hint = document.createElement("div");
    const errorRegion = document.createElement("div");

    const dispose = fu.bind({ input, dropZone, hint, errorRegion });

    expect(input.accept).toBe(".txt");
    expect(input.multiple).toBe(true);
    expect(hint.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(errorRegion.getAttribute("role")).toBe("status");
    expect(errorRegion.getAttribute("aria-live")).toBe("polite");
    expect(dropZone.getAttribute("role")).toBe("button");
    expect(dropZone.tabIndex).toBe(0);
    expect(dropZone.getAttribute("data-drag-over")).toBe("false");

    // change event with files
    const file = makeFile("a.txt", 10);
    Object.defineProperty(input, "files", { value: makeFileList([file]), configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(fu.files().length).toBe(1);

    // error region reflects errors reactively
    fu.addFiles([makeFile("bad.png", 10, "image/png")]);
    expect(errorRegion.textContent).toContain("not an accepted type");

    dispose();
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(hint.id).toBe("");
  });

  it("bind preserves existing aria-describedby and restores it", () => {
    const fu = fileUpload();
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("aria-describedby", "existing");
    const hint = document.createElement("div");
    hint.id = "myhint";
    const dispose = fu.bind({ input, hint });
    expect(input.getAttribute("aria-describedby")).toBe("existing myhint");
    dispose();
    expect(input.getAttribute("aria-describedby")).toBe("existing");
    // pre-existing hint id is preserved
    expect(hint.id).toBe("myhint");
  });

  it("bind returns the same teardown when called twice on same input", () => {
    const fu = fileUpload();
    const input = document.createElement("input");
    input.type = "file";
    const d1 = fu.bind({ input });
    const d2 = fu.bind({ input });
    expect(d1).toBe(d2);
    d1();
  });

  it("drop zone click opens input and Enter/Space activate it", () => {
    const fu = fileUpload();
    const input = document.createElement("input");
    input.type = "file";
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});
    const dropZone = document.createElement("div");
    const dispose = fu.bind({ input, dropZone });

    dropZone.dispatchEvent(new MouseEvent("click"));
    expect(clickSpy).toHaveBeenCalledTimes(1);

    dropZone.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(clickSpy).toHaveBeenCalledTimes(2);

    dropZone.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(clickSpy).toHaveBeenCalledTimes(3);

    dropZone.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(clickSpy).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("dragover/dragleave/drop update drag state and add files", () => {
    const fu = fileUpload({ multiple: true });
    const input = document.createElement("input");
    input.type = "file";
    const dropZone = document.createElement("div");
    const dispose = fu.bind({ input, dropZone });

    const dragOver = new Event("dragover") as DragEvent;
    dropZone.dispatchEvent(dragOver);
    expect(fu.isDragOver()).toBe(true);
    expect(dropZone.getAttribute("data-drag-over")).toBe("true");

    dropZone.dispatchEvent(new Event("dragleave"));
    expect(fu.isDragOver()).toBe(false);

    const file = makeFile("dropped.txt", 10);
    const dropEvent = new Event("drop") as DragEvent;
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: makeFileList([file]) },
    });
    dropZone.dispatchEvent(dropEvent);
    expect(fu.isDragOver()).toBe(false);
    expect(fu.files().map((f) => f.name)).toContain("dropped.txt");

    dispose();
  });

  it("teardown restores pre-existing error region and drop zone attributes", () => {
    const fu = fileUpload();
    const input = document.createElement("input");
    input.type = "file";
    const errorRegion = document.createElement("div");
    errorRegion.setAttribute("role", "log");
    errorRegion.setAttribute("aria-live", "assertive");
    const dropZone = document.createElement("div");
    dropZone.setAttribute("role", "region");
    dropZone.setAttribute("aria-label", "previous label");
    dropZone.setAttribute("tabindex", "5");

    const dispose = fu.bind({ input, dropZone, errorRegion });
    expect(errorRegion.getAttribute("role")).toBe("status");
    expect(dropZone.getAttribute("role")).toBe("button");
    // tabindex >= 0 is preserved (not overwritten)
    expect(dropZone.getAttribute("tabindex")).toBe("5");

    dispose();
    expect(errorRegion.getAttribute("role")).toBe("log");
    expect(errorRegion.getAttribute("aria-live")).toBe("assertive");
    expect(dropZone.getAttribute("role")).toBe("region");
    expect(dropZone.getAttribute("aria-label")).toBe("previous label");
    expect(dropZone.getAttribute("tabindex")).toBe("5");
  });

  it("teardown removes listeners", () => {
    const fu = fileUpload();
    const input = document.createElement("input");
    input.type = "file";
    const dropZone = document.createElement("div");
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});
    const dispose = fu.bind({ input, dropZone });
    dispose();
    dropZone.dispatchEvent(new MouseEvent("click"));
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
