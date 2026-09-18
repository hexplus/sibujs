/**
 * Deterministic, unambiguous DOM serialization shared by the testing helpers
 * (`createDOMSnapshot`, `snapshotComponent`, visual fingerprints).
 *
 * Attribute values, text and comments are escaped, so the output of two
 * different trees can never collide: an attribute value `x" b="y` used to
 * serialize exactly like two attributes `a="x" b="y"`, and text `<span>` like a
 * real `<span>` element.
 */

/** Escape text content: `&`, `<`, `>`. */
export function escapeSnapshotText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value for a double-quoted context. */
export function escapeSnapshotAttribute(value: string): string {
  return escapeSnapshotText(value).replace(/"/g, "&quot;");
}

/** Escape comment data so it cannot close the comment early. */
function escapeSnapshotComment(value: string): string {
  return escapeSnapshotText(value).replace(/-/g, "&#45;");
}

export interface SerializeDomOptions {
  /** Include comment nodes (default false). */
  comments?: boolean;
}

/**
 * Serialize an element to an indented string. Attributes are sorted by name,
 * whitespace-only text is dropped and text is trimmed.
 */
export function serializeDom(el: Element, indent = 0, options: SerializeDomOptions = {}): string {
  const pad = "  ".repeat(indent);
  const tag = el.tagName.toLowerCase();

  const attrs = Array.from(el.attributes)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((a) => `${a.name}="${escapeSnapshotAttribute(a.value)}"`)
    .join(" ");

  const open = attrs ? `${pad}<${tag} ${attrs}>` : `${pad}<${tag}>`;
  const children = Array.from(el.childNodes);

  if (children.length === 0) {
    return `${open}</${tag}>`;
  }

  // Single text node child — keep inline.
  if (children.length === 1 && children[0].nodeType === 3) {
    return `${open}${escapeSnapshotText(children[0].textContent?.trim() || "")}</${tag}>`;
  }

  const childPad = "  ".repeat(indent + 1);
  const childStr = children
    .map((child) => {
      if (child.nodeType === 3) {
        const text = child.textContent?.trim();
        return text ? `${childPad}${escapeSnapshotText(text)}` : "";
      }
      if (child.nodeType === 1) {
        return serializeDom(child as Element, indent + 1, options);
      }
      if (child.nodeType === 8 && options.comments) {
        return `${childPad}<!-- ${escapeSnapshotComment(child.textContent?.trim() || "")} -->`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return `${open}\n${childStr}\n${pad}</${tag}>`;
}
