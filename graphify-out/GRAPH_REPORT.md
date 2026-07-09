# Graph Report - .  (2026-07-08)

## Corpus Check
- Large corpus: 608 files · ~369,154 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 201 nodes · 128 edges · 125 communities (10 shown, 115 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Rendering & Lifecycle
- Signals & Reactivity Core
- Islands & Attribute Binding
- Testing Utilities
- Data Fetching
- Element Factories
- UI Library Adapters
- Motion & Animation
- State Library Adapters
- Router & SSR
- DevTools Profiler
- Compiled Performance
- Scheduler & Concurrency
- Loading
- catch
- createId
- slots
- nextTick
- guards
- animationFrame
- battery
- bounds
- broadcast
- clipboard
- colorScheme
- dragDrop
- favicon
- format
- fullscreen
- gamepad
- geo
- idle
- imageLoader
- keyboard
- media
- mouse
- mutationObserver
- network
- online
- permissions
- pointerLock
- resize
- scroll
- speech
- swipe
- textSelection
- title
- urlState
- vibrate
- visibility
- wakeLock
- windowSize
- debug
- debugValue
- devtools
- devtoolsOverlay
- hmr
- introspect
- signalGraph
- sourceMaps
- transition
- TransitionGroup
- viewTransition
- componentProps
- composable
- contracts
- globalStore
- hoc
- machine
- optimistic
- persist
- timeTravel
- bundleOptimize
- chunkLoader
- domRecycler
- normalize
- Accordion
- Combobox
- contentEditable
- datePicker
- FileUpload
- Popover
- Select
- Tabs
- Tooltip
- debounce
- offlineStore
- previous
- throttle
- customElement
- head
- incrementalRegeneration
- microfrontend
- routeActions
- routeMiddleware
- scrollRestoration
- serviceWorker
- staticSiteGenerator
- wasm
- worker
- ecosystem
- i18n
- modular
- plugin
- versioning
- a11y
- a11yPrimitives
- dialog
- eventBus
- form
- formAction
- hover
- infiniteScroll
- inputMask
- intersection
- lazyEffect
- pagination
- reactiveAttr
- scopedStyle
- scrollLock
- socket
- stream
- timers
- toast
- virtualList

## God Nodes (most connected - your core abstractions)
1. `core: core/dev` - 25 edges
2. `core: core/rendering/dispose` - 20 edges
3. `core: core/signals/signal` - 13 edges
4. `core: core/rendering/tagFactory` - 9 edges
5. `core: core/rendering/htm` - 7 edges
6. `core: core/rendering/types` - 7 edges
7. `core: core/signals/effect` - 7 edges
8. `core: reactivity/bindChildNode` - 7 edges
9. `core: components/ErrorBoundary` - 6 edges
10. `core: reactivity/signal` - 6 edges

## Surprising Connections (you probably didn't know these)
- `sibujs: testing/index` --re_exports--> `sibujs: testing/a11y`  [EXTRACTED]
  packages/sibujs/src/testing/index.ts → packages/sibujs/src/testing/a11y.ts
- `sibujs: testing/index` --re_exports--> `sibujs: testing/adapters`  [EXTRACTED]
  packages/sibujs/src/testing/index.ts → packages/sibujs/src/testing/adapters.ts
- `sibujs: testing/index` --re_exports--> `sibujs: testing/e2e`  [EXTRACTED]
  packages/sibujs/src/testing/index.ts → packages/sibujs/src/testing/e2e.ts
- `sibujs: testing/index` --re_exports--> `sibujs: testing/queries`  [EXTRACTED]
  packages/sibujs/src/testing/index.ts → packages/sibujs/src/testing/queries.ts
- `sibujs: testing/index` --re_exports--> `sibujs: testing/snapshot`  [EXTRACTED]
  packages/sibujs/src/testing/index.ts → packages/sibujs/src/testing/snapshot.ts

## Import Cycles
- None detected.

## Communities (125 total, 115 thin omitted)

### Community 0 - "Rendering & Lifecycle"
Cohesion: 0.12
Nodes (23): c/projects/mine/sibujs/sibujs/packages/core/src/core/rendering/lifecycle/runmountcallback, c/projects/mine/sibujs/sibujs/packages/core/src/core/rendering/lifecycle/safecall, c/projects/mine/sibujs/sibujs/packages/core/src/core/rendering/tagfactory/appendchildren, c/projects/mine/sibujs/sibujs/packages/core/src/core/rendering/tagfactory/applyclass, c/projects/mine/sibujs/sibujs/packages/core/src/core/rendering/tagfactory/applystyle, c/projects/mine/sibujs/sibujs/packages/core/src/reactivity/track/core/safeinvoke, c/projects/mine/sibujs/sibujs/packages/core/src/reactivity/track/resolvereactiveapi, core: components/ErrorBoundary (+15 more)

### Community 1 - "Signals & Reactivity Core"
Cohesion: 0.15
Nodes (17): c/projects/mine/sibujs/sibujs/packages/core/src/reactivity/track/core/subnode, core: core/rendering/context, core: core/signals/array, core: core/signals/asyncDerived, core: core/signals/deepSignal, core: core/signals/derived, core: core/signals/effect, core: core/signals/ref (+9 more)

### Community 2 - "Islands & Attribute Binding"
Cohesion: 0.36
Nodes (8): c/projects/mine/sibujs/sibujs/packages/core/src/core/rendering/htm/executeelement, core: core/rendering/htm, core: platform/enhance, core: platform/islands, core: reactivity/bindAttribute, core: reactivity/bindChildNode, core: utils/globalSingleton, core: utils/sanitize

### Community 3 - "Testing Utilities"
Cohesion: 0.29
Nodes (7): sibujs: testing/a11y, sibujs: testing/adapters, sibujs: testing/e2e, sibujs: testing/index, sibujs: testing/queries, sibujs: testing/snapshot, sibujs: testing/visualRegression

### Community 4 - "Data Fetching"
Cohesion: 0.33
Nodes (6): sibujs: data/infiniteQuery, sibujs: data/mutation, sibujs: data/query, sibujs: data/resource, sibujs: data/retry, sibujs: data/routeLoader

### Community 5 - "Element Factories"
Cohesion: 0.50
Nodes (5): core: core/rendering/fragment, core: core/rendering/html, core: core/rendering/tagFactory, core: core/rendering/tagPropTypes, core: core/rendering/types

### Community 6 - "UI Library Adapters"
Cohesion: 0.70
Nodes (5): labs: ecosystem/ui/antd, labs: ecosystem/ui/chakra, labs: ecosystem/ui/componentAdapter, labs: ecosystem/ui/index, labs: ecosystem/ui/material

### Community 7 - "Motion & Animation"
Cohesion: 0.50
Nodes (4): c/projects/mine/sibujs/sibujs/packages/labs/src/motion/animationpresets/createpreset, labs: motion/animationPresets, labs: motion/reducedMotion, labs: motion/springSignal

### Community 8 - "State Library Adapters"
Cohesion: 0.50
Nodes (4): labs: ecosystem/adapters/index, labs: ecosystem/adapters/mobx, labs: ecosystem/adapters/redux, labs: ecosystem/adapters/zustand

### Community 9 - "Router & SSR"
Cohesion: 0.50
Nodes (4): sibujs: platform/ssr, sibujs: plugins/router, sibujs: plugins/routerSSR, sibujs: plugins/startup

## Knowledge Gaps
- **143 isolated node(s):** `core: components/Loading`, `core: core/rendering/action`, `core: core/rendering/catch`, `core: core/rendering/context`, `core: core/rendering/createId` (+138 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **115 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `core: core/dev` connect `Rendering & Lifecycle` to `Signals & Reactivity Core`, `Islands & Attribute Binding`, `Element Factories`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `core: core/rendering/dispose` connect `Rendering & Lifecycle` to `Islands & Attribute Binding`, `Element Factories`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **Why does `core: core/signals/signal` connect `Signals & Reactivity Core` to `Rendering & Lifecycle`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **What connects `core: components/Loading`, `core: core/rendering/action`, `core: core/rendering/catch` to the rest of the system?**
  _143 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Rendering & Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.11857707509881422 - nodes in this community are weakly interconnected._
- **Should `Signals & Reactivity Core` be split into smaller, more focused modules?**
  _Cohesion score 0.14705882352941177 - nodes in this community are weakly interconnected._