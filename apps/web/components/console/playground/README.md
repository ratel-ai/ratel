# `components/console/playground/`

Catalog › Test a search, rebuilt on `@ratel/design-system` as upstream did (ratel-cloud #354). The folder keeps upstream's name, and so does the route (`/playground`); the UI never says it. Every file here is copied from upstream; only this README is local.

One flow: search an ask, see the ranked tools with the matched words lit, name the tool that should come first, rewrite its searchable description in the Panel and test it, then save or copy the change.

| File | What it is |
|---|---|
| `PlaygroundWorkbench.tsx` | the page's state: the ask, the expected tool, drafts, runs and saves |
| `SearchForm.tsx`, `MatchSettings.tsx`, `MixSlider.tsx`, `TagInput.tsx` | the ask and how it is matched (Keyword, Semantic or Hybrid) |
| `ResultSection.tsx`, `CompareView.tsx`, `Highlighted.tsx`, `ResultsSkeleton.tsx` | the results: a List, or a Compare view when there is a before (an experiment's recorded variants, or Before and After your changes), with the matched words lit |
| `CapabilityPanel.tsx`, `ChangesBar.tsx`, `useCatalogSave.ts` | a tool's description rewritten in the Panel, the unsaved changes, and their save |
| `ExperimentNotice.tsx`, `FirstRun.tsx` | the notice when an experiment's search is carried in, and the page before the first search |
