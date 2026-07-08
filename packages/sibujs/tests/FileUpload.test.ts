import { describe, expect, it, vi } from "vitest";
import { fileUpload } from "../src/widgets/FileUpload";

describe("fileUpload", () => {
  function mockFile(name: string, size: number = 100, type: string = "text/plain"): File {
    return new File(["x".repeat(size)], name, { type });
  }

  it("starts with no files and no errors", () => {
    const upload = fileUpload();
    expect(upload.files()).toEqual([]);
    expect(upload.errors()).toEqual([]);
    expect(upload.isDragOver()).toBe(false);
  });

  it("adds files and calls onFiles callback", () => {
    const onFiles = vi.fn();
    const upload = fileUpload({ multiple: true, onFiles });

    const f1 = mockFile("test1.txt");
    const f2 = mockFile("test2.txt");
    upload.addFiles([f1, f2]);

    expect(upload.files()).toEqual([f1, f2]);
    expect(onFiles).toHaveBeenCalledWith([f1, f2]);
  });

  it("replaces file in single mode", () => {
    const upload = fileUpload({ multiple: false });

    const f1 = mockFile("a.txt");
    upload.addFiles([f1]);
    expect(upload.files()).toEqual([f1]);

    const f2 = mockFile("b.txt");
    upload.addFiles([f2]);
    expect(upload.files()).toEqual([f2]);
  });

  it("rejects files exceeding maxSize", () => {
    const upload = fileUpload({ maxSize: 50, multiple: true });

    const small = mockFile("small.txt", 30);
    const large = mockFile("large.txt", 100);
    upload.addFiles([small, large]);

    expect(upload.files()).toEqual([small]);
    expect(upload.errors().length).toBe(1);
    expect(upload.errors()[0]).toContain("large.txt");
  });

  it("rejects files not matching accept type", () => {
    const upload = fileUpload({ accept: ".txt,.csv", multiple: true });

    const txt = mockFile("doc.txt", 10, "text/plain");
    const png = mockFile("img.png", 10, "image/png");
    upload.addFiles([txt, png]);

    expect(upload.files()).toEqual([txt]);
    expect(upload.errors().length).toBe(1);
    expect(upload.errors()[0]).toContain("img.png");
  });

  it("removes a file by index and clears all", () => {
    const upload = fileUpload({ multiple: true });

    const f1 = mockFile("a.txt");
    const f2 = mockFile("b.txt");
    const f3 = mockFile("c.txt");
    upload.addFiles([f1, f2, f3]);

    upload.removeFile(1);
    expect(upload.files()).toEqual([f1, f3]);

    upload.clear();
    expect(upload.files()).toEqual([]);
    expect(upload.errors()).toEqual([]);
  });

  it("manages dragOver state", () => {
    const upload = fileUpload();
    upload.setDragOver(true);
    expect(upload.isDragOver()).toBe(true);
    upload.setDragOver(false);
    expect(upload.isDragOver()).toBe(false);
  });
});
