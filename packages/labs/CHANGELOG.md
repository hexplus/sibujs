# Changelog

All notable changes to `@sibujs/labs` will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

---

## [4.0.0-alpha.0]

Initial release of `@sibujs/labs`. It gathers the opt-in long-tail modules that
previously shipped as `sibujs` subpaths, under a lower support guarantee.

### Added

- Subpaths: `@sibujs/labs/browser`, `/widgets`, `/patterns`, `/motion`,
  `/ecosystem`, `/performance`, `/devtools`, plus the `@sibujs/labs` aggregate.
- Depends on `@sibujs/core` and `sibujs`, both kept external so labs never
  bundles its own copy of the engine or the std layer.
