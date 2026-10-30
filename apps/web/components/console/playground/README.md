# `components/console/playground/`

The "Test a search" page: the Micro style on `@ratel/design-system` (`DESIGN.md`, Declared exceptions). The folder keeps upstream's name; the UI never says it.

| File | What it is |
|---|---|
| `PlaygroundWorkbench.tsx` | the page's state: prompt, drafts, run, saves |
| `PromptPanel.tsx`, `MixSlider.tsx`, `SuggestionMenu.tsx` | the prompt and how it is matched |
| `ResultsPanel.tsx`, `BucketColumns.tsx`, `ScorePeek.tsx`, `ResultsSkeleton.tsx` | the rankings, as columns |
| `CalibrationBanner.tsx` | the notice when a recorded comparison is carried in |
| `CapabilityBench.tsx`, `BenchRow.tsx`, `DescriptionPanel.tsx`, `TagInput.tsx`, `EditsBar.tsx` | the catalog, its editor and the export of unsaved edits |
| `icons.tsx`, `CatalogProvenanceBadge.tsx`, `PartialDataValue.tsx`, `BenchTooltip.tsx`, `field.ts` | the marks, the estimate, and this screen's tooltip and field surfaces |
