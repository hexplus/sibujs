/**
 * Snapshot `names` on `el` and return a function that puts each one back
 * exactly: re-set to its previous value, or removed if it was absent. Widgets
 * binding over author markup use it so teardown never deletes attributes the
 * author wrote.
 *
 * @internal
 */
export function snapshotAttributes(el: Element, names: string[]): () => void {
  const previous = names.map((name) => [name, el.getAttribute(name)] as const);
  return () => {
    for (const [name, value] of previous) {
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  };
}
