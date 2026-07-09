# @sibujs/labs

Opt-in long-tail modules for [SibuJS](https://sibujs.dev). These are useful but
niche building blocks that live outside the maintained core/std surface and carry
a **lower support guarantee** than [`@sibujs/core`](https://www.npmjs.com/package/@sibujs/core)
and [`sibujs`](https://www.npmjs.com/package/sibujs). Items here may graduate to
the std tier or be retired over time.

## Install

```bash
npm install @sibujs/labs
```

`@sibujs/labs` lists `@sibujs/core` and `sibujs` as regular dependencies, so your
package manager installs them automatically — you don't need to add them yourself.

## Subpaths

Import from a specific subpath for the best tree-shaking:

- **`@sibujs/labs/browser`** — reactive wrappers around browser APIs (`media`,
  `resize`, `scroll`, `geo`, `clipboard`, `keyboard`, `gamepad`, and ~30 more).
- **`@sibujs/labs/widgets`** — accessible prebuilt components (`Combobox`, `Tabs`,
  `Accordion`, `Popover`, `Select`, `Tooltip`, `FileUpload`, `datePicker`, …).
- **`@sibujs/labs/patterns`** — state & component patterns (`machine`, `persist`,
  `optimistic`, `timeTravel`, `globalStore`, `hoc`, `composable`, `contracts`).
- **`@sibujs/labs/motion`** — transitions & animation (`transition`,
  `TransitionGroup`, `viewTransition`, `springSignal`, `animationPresets`).
- **`@sibujs/labs/ecosystem`** — adapters for third-party state/UI libraries.
- **`@sibujs/labs/performance`** — scheduling & optimization utilities.
- **`@sibujs/labs/devtools`** — debugging, profiling, and inspection helpers.
- **`@sibujs/labs`** — convenience aggregate of every subpath above.

```javascript
import { media } from "@sibujs/labs/browser";
import { machine } from "@sibujs/labs/patterns";
import { transition } from "@sibujs/labs/motion";
```

## License

MIT © [hexplus](https://github.com/hexplus)
