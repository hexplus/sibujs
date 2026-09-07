import { registerIsland, lazyIsland } from "../src/platform/islands";
import type { EnhanceSetup } from "../src/platform/enhance";

// (1) The correct form.
registerIsland("ok", lazyIsland(() => import("./mod.js") as Promise<{ default: EnhanceSetup }>));

// (2) The mistake: a loader that was never wrapped.
registerIsland("oops", () => import("./mod.js") as Promise<{ default: EnhanceSetup }>);

// (3) Is a zero-arg promise-returning fn assignable to EnhanceSetup directly?
const asSetup: EnhanceSetup = () => Promise.resolve(1) as unknown as Promise<number>;
void asSetup;
