// RC-002 probe: a process that used the query cache must exit on its own.
//
// Deliberately a standalone script rather than an assertion inside a larger
// harness: the thing under test is *process exit*, which can only be observed
// from outside. The parent spawns this, waits, and fails if it is still alive.
// Nothing here may call process.exit() on the success path — that would mask
// exactly the defect being probed (an un-unref'd timer holding the event loop).
import { query, setQueryData, getQueryData } from "sibujs/data";

const q = query("clean-exit-probe", async () => "value", { retry: { maxRetries: 0 } });

setTimeout(() => {
  const data = q.data();
  setQueryData("clean-exit-probe", "written");
  const after = getQueryData("clean-exit-probe");
  q.dispose();
  console.log(`CLEAN_EXIT_PROBE data=${data} after=${after}`);
  // No process.exit(). If the GC timer is ref'd, Node stays alive here.
}, 50);
