/**
 * components/session-replay/WhatIfPanel inside a view (swapped in by
 * scripts/build.mts).
 *
 * What if… runs a model call again through the console's server actions; a view
 * has none, and passes no `whatIf` to the replay, so the step inspector never
 * renders the panel. The shim keeps its form (the DS Select, Toast, Input and
 * their floating UI, about 110 KB) out of every view bundle.
 */
import type { WhatIfOptions, WhatIfRunView } from "@/lib/views/session-replay/what-if";

export interface ForkTarget {
  turnId: string;
  call: number;
}

export function WhatIfPanel(_props: {
  projectId: string;
  target: ForkTarget;
  options: WhatIfOptions;
  runs: readonly WhatIfRunView[];
  readContent: boolean;
}): null {
  return null;
}
