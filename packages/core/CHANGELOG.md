# Changelog

All notable changes to `@sibujs/core` will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

---

## [4.0.0-alpha.0]

Initial release of `@sibujs/core` as a standalone package. It contains the
reactivity + rendering engine previously bundled inside `sibujs`.

### Added

- Standalone engine package: signals, direct-DOM rendering, control flow,
  components, lifecycle, and islands/progressive-enhancement primitives.
- `StaticGetter<T>` type — a non-subscribing getter, distinct from the reactive
  `Accessor<T>`. Used to type the `item`/`index` getters of an `each()` render
  callback so the "reads fresh but does not subscribe" contract is explicit.

### Changed

- The duplicate-runtime registry is now a development-only tripwire. With a
  single resolved `@sibujs/core`, reactivity does not depend on it; a detected
  duplicate is reported with a one-time dev warning pointing at bundler dedup.
