import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";

let fileUploadIdCounter = 0;
const boundFileUploads = new WeakMap<HTMLElement, () => void>();

export interface FileUploadOptions {
  accept?: string;
  multiple?: boolean;
  maxSize?: number;
  onFiles?: (files: File[]) => void;
}

export function fileUpload(options?: FileUploadOptions): {
  files: () => File[];
  addFiles: (fileList: FileList | File[]) => void;
  removeFile: (index: number) => void;
  clear: () => void;
  errors: () => string[];
  isDragOver: () => boolean;
  setDragOver: (v: boolean) => void;
  /** Wires native file input + drop zone with proper labeling, hint
   *  description, and keyboard activation. Returns dispose. */
  bind: (els: {
    input: HTMLInputElement;
    dropZone?: HTMLElement;
    hint?: HTMLElement;
    errorRegion?: HTMLElement;
  }) => () => void;
} {
  const accept = options?.accept;
  const multiple = options?.multiple ?? false;
  const maxSize = options?.maxSize;
  const onFiles = options?.onFiles;

  const [files, setFiles] = signal<File[]>([]);
  const [errors, setErrors] = signal<string[]>([]);
  const [isDragOver, setDragOver] = signal<boolean>(false);

  /**
   * Parse the accept string into an array of allowed types/extensions.
   * Supports patterns like ".jpg,.png", "image/*", "application/pdf"
   */
  function isAccepted(file: File): boolean {
    if (!accept) return true;

    const acceptedTypes = accept.split(",").map((t) => t.trim().toLowerCase());
    const fileName = file.name.toLowerCase();
    const fileType = file.type.toLowerCase();

    return acceptedTypes.some((pattern) => {
      if (pattern.startsWith(".")) {
        // Extension match
        return fileName.endsWith(pattern);
      }
      if (pattern.endsWith("/*")) {
        // Wildcard type match, e.g., "image/*"
        const prefix = pattern.slice(0, pattern.indexOf("/"));
        return fileType.startsWith(`${prefix}/`);
      }
      // Exact MIME type match
      return fileType === pattern;
    });
  }

  function addFiles(fileList: FileList | File[]): void {
    const incoming = Array.from(fileList);
    const validFiles: File[] = [];
    const newErrors: string[] = [];

    for (const file of incoming) {
      if (!isAccepted(file)) {
        newErrors.push(`File "${file.name}" is not an accepted type`);
        continue;
      }
      if (maxSize !== undefined && file.size > maxSize) {
        newErrors.push(`File "${file.name}" exceeds maximum size of ${maxSize} bytes`);
        continue;
      }
      validFiles.push(file);
    }

    batch(() => {
      setErrors(newErrors);
      if (validFiles.length > 0) {
        if (multiple) {
          setFiles((prev) => [...prev, ...validFiles]);
        } else {
          // Single mode: replace with the last valid file
          setFiles([validFiles[validFiles.length - 1]]);
        }
        if (onFiles) {
          onFiles(validFiles);
        }
      }
    });
  }

  function removeFile(index: number): void {
    setFiles((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
  }

  function clear(): void {
    batch(() => {
      setFiles([]);
      setErrors([]);
    });
  }

  function bind(els: {
    input: HTMLInputElement;
    dropZone?: HTMLElement;
    hint?: HTMLElement;
    errorRegion?: HTMLElement;
  }): () => void {
    const existing = boundFileUploads.get(els.input);
    if (existing) return existing;

    const id = `sibu-fileupload-${++fileUploadIdCounter}`;
    const restore: Array<() => void> = [];
    if (accept) els.input.accept = accept;
    els.input.multiple = multiple;
    let hintId: string | null = null;
    if (els.hint) {
      const assignedHintId = !els.hint.id;
      if (assignedHintId) els.hint.id = `${id}-hint`;
      hintId = els.hint.id;
      const prev = els.input.getAttribute("aria-describedby");
      els.input.setAttribute("aria-describedby", prev ? `${prev} ${hintId}` : hintId);
      restore.push(() => {
        // Splice our id out, preserving any other ids that may have been added.
        const cur = els.input.getAttribute("aria-describedby");
        if (cur) {
          const parts = cur.split(/\s+/).filter((p) => p && p !== hintId);
          if (parts.length > 0) els.input.setAttribute("aria-describedby", parts.join(" "));
          else els.input.removeAttribute("aria-describedby");
        }
        if (assignedHintId && els.hint && els.hint.id === hintId) els.hint.removeAttribute("id");
      });
    }
    if (els.errorRegion) {
      // role=alert implies aria-live=assertive; setting both is redundant.
      // Use status+polite for non-blocking validation errors per APG.
      const prevRole = els.errorRegion.getAttribute("role");
      const prevLive = els.errorRegion.getAttribute("aria-live");
      els.errorRegion.setAttribute("role", "status");
      els.errorRegion.setAttribute("aria-live", "polite");
      restore.push(() => {
        if (prevRole === null) els.errorRegion!.removeAttribute("role");
        else els.errorRegion!.setAttribute("role", prevRole);
        if (prevLive === null) els.errorRegion!.removeAttribute("aria-live");
        else els.errorRegion!.setAttribute("aria-live", prevLive);
      });
    }
    if (els.dropZone) {
      const prevDzRole = els.dropZone.getAttribute("role");
      const prevDzLabel = els.dropZone.getAttribute("aria-label");
      const prevDzTabindex = els.dropZone.hasAttribute("tabindex") ? els.dropZone.getAttribute("tabindex") : null;
      els.dropZone.setAttribute("role", "button");
      els.dropZone.setAttribute("aria-label", "File drop zone — click or press Enter to browse");
      if (els.dropZone.tabIndex < 0) els.dropZone.tabIndex = 0;
      restore.push(() => {
        if (prevDzRole === null) els.dropZone!.removeAttribute("role");
        else els.dropZone!.setAttribute("role", prevDzRole);
        if (prevDzLabel === null) els.dropZone!.removeAttribute("aria-label");
        else els.dropZone!.setAttribute("aria-label", prevDzLabel);
        if (prevDzTabindex === null) els.dropZone!.removeAttribute("tabindex");
        else els.dropZone!.setAttribute("tabindex", prevDzTabindex);
      });
    }

    const fxTeardown = effect(() => {
      const errs = errors();
      if (els.errorRegion) els.errorRegion.textContent = errs.join(". ");
      if (els.dropZone) els.dropZone.setAttribute("data-drag-over", isDragOver() ? "true" : "false");
    });

    const onChange = () => {
      if (els.input.files) addFiles(els.input.files);
    };
    const onDropClick = () => els.input.click();
    const onDropKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        els.input.click();
      }
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = () => setDragOver(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
    };

    els.input.addEventListener("change", onChange);
    if (els.dropZone) {
      els.dropZone.addEventListener("click", onDropClick);
      els.dropZone.addEventListener("keydown", onDropKey);
      els.dropZone.addEventListener("dragover", onDragOver);
      els.dropZone.addEventListener("dragleave", onDragLeave);
      els.dropZone.addEventListener("drop", onDrop);
    }

    const teardown = () => {
      boundFileUploads.delete(els.input);
      fxTeardown();
      els.input.removeEventListener("change", onChange);
      if (els.dropZone) {
        els.dropZone.removeEventListener("click", onDropClick);
        els.dropZone.removeEventListener("keydown", onDropKey);
        els.dropZone.removeEventListener("dragover", onDragOver);
        els.dropZone.removeEventListener("dragleave", onDragLeave);
        els.dropZone.removeEventListener("drop", onDrop);
      }
      for (const r of restore) r();
    };
    boundFileUploads.set(els.input, teardown);
    return teardown;
  }

  return {
    files,
    addFiles,
    removeFile,
    clear,
    errors,
    isDragOver,
    setDragOver,
    bind,
  };
}
