# Ratel design language

Every UI change in the platform, in both editions, follows this document and is built from
`@ratel/design-system` and its tokens. Where older code disagrees, the code changes.

## Character

- **Sentence case everywhere**, buttons and titles included.
- **Coral is the accent** and the brand. Blue is for charts and info.
- **Dark first.** Light mode comes later through the same semantic tokens.
- **Pixel and dot-matrix are the signature** (see Brand).

## Principles

1. **Content first, chrome recedes.** Never a card in a card.
2. **One question per page**, answered above the fold; everything else is a drill-down.
3. **Plain language over engine names.** No engine names, metrics, snake_case types or formulas
   on default views; they go behind "Details" (see Glossary).
4. **Show, don't explain.** At most one sentence under a title.
5. **Color is meaning.** The UI is gray; coral marks the primary action, selection and focus.
6. **No page ships with only its happy path.** The first visit, the busy day and the failure
   are designed too.
7. **Everything is a URL.** A copied link reopens the same view, panel and window.
8. **Keyboard first.** ⌘K, `[` for the sidebar, `g` to jump, `j`/`k`, `Enter`, `Esc`.
9. **Motion only shows where something went.**
10. **One way to do each thing.** A page that needs a variant grows the primitive, never forks it.

## Information architecture

At most 9 project items; nothing "Soon"; one home per concept and per editable field; items the
edition lacks are not rendered; moved pages redirect.

| Item | Answers | Contains |
|---|---|---|
| Overview | How is this project doing? | Numbers, "Needs attention", recent runs |
| Agent health | What does my agent get wrong? | Summary, Tasks, Self-corrections |
| Traces | What happened in a run? | Runs, Spans, Logs |
| Catalog | What can my agent use? | Tools, Skills, Test |
| Intents | What do people want, and what next? | All intents, Flows, Map |
| Improvements | What should I change? | Fixes, Quality, Adaptive ranking |
| Settings | Project configuration | General, API keys, Developer, Danger zone |

## Layout

- **Inverted-L frame:** sidebar (240 px, 48 collapsed, a drawer on phones) and a 52 px page
  header; no top bar.
- **Grid:** 4 px. Page padding 24 px (32 px from `lg`); 32 px between sections, 16 px inside, 8 px
  between related controls.
- **Width:** reading and form pages cap at 1200 px; tables, traces and maps run full width.
- **Density:** rows 36 px (32 compact), nav items and controls 32 px (28 small).

## Foundations

Tokens live in `src/styles.css` of this package, on top of [`@ratel/brand`](../brand/README.md),
defined on `:root` so portalled overlays resolve them too.

### Color

Geist step semantics: 100 to 300 backgrounds, 400 to 600 borders, 700 and 800 solid fills, 900
and 1000 text. Grays carry a faint forest tint.

| Step | Value | Token | Use |
|---|---|---|---|
| background-200 | `#060908` | `bg-rail` | Sidebar |
| background-100 | `#0b0e0d` | `bg-app` | Page, inputs |
| gray-100 | `#121614` | `bg-raised` | Section surfaces, table frames |
| gray-100 + border | `#121614` | `bg-overlay` | Popover, menu, dialog, panel |
| gray-200 | `#181c1a` | `bg-hover` | Row and item hover |
| gray-300 | `#1e2321` | `bg-selected` | Selected row, active item |
| gray-400 | `#272b29` | `border-line` | Default hairline |
| gray-500 | `#343937` | `border-line-strong` | Inputs, hover borders |
| gray-600 | `#4c514f` | `border-line-active` | Pressed, dragged |
| gray-700 | `#797d7b` | `text-fg-faint` | Placeholder, disabled (4.65:1, never body copy) |
| gray-800 | `#898d8b` | `text-fg-subtle` | Meta, axis labels, timestamps (5.8:1) |
| gray-900 | `#a9acaa` | `text-fg-muted` | Secondary text (8.5:1) |
| gray-1000 | `#eef1ef` | `text-fg` | Primary text (17:1) |

| Token | Value | Use | Contrast |
|---|---|---|---|
| `bg-accent` | `#c4431f` | Primary button fill | white text 5.0:1 |
| `bg-accent-hover` | `#b83c1a` | Primary button hover | white text 5.7:1 |
| `bg-accent-mark`, `text-accent-mark`, `ring-focus` | `#ed5126` | Focus ring, selection mark, accent icon | 5.4:1 on app |
| `bg-accent-subtle` | coral at 12% | Selected item tint | |
| `text-success`, `bg-success-subtle` | `#5ac576`, 12% | Healthy, passed, applied | 9.0:1 |
| `text-warning`, `bg-warning-subtle` | `#edb345`, 12% | Worth a look, degraded | 10.3:1 |
| `text-danger`, `bg-danger-subtle` | `#f75b6b`, 12% | Failed, error, destructive | 6.2:1 |
| `bg-danger` | `#d73246` | Destructive button fill | white text 4.7:1 |
| `text-info`, `bg-info-subtle` | `#5eaceb`, 12% | Neutral notices | 7.9:1 |
| `bg-scrim` | black at 60% | Behind dialogs | |
| `text-brand-cream` | `#eee3ce` | The badger mark only | |

- Coral is never a status color or a chart series; danger is a rose red, away from coral.
- Status is never color alone: a dot or icon plus a word.
- Numbers stay `text-fg`; a colored mark beside them carries the meaning.
- Semantic names only: no raw hex, no palette utilities (`white`, `black`, `amber-*`).

### Typography

Geist Sans; Geist Mono for ids, code and keys; Geist Pixel Square for brand moments.

| Role | Tailwind | Size / line | Weight |
|---|---|---|---|
| Page title | `text-xl font-semibold tracking-tight` | 20 / 28 | 600 |
| Stat value | `text-2xl font-semibold tabular-nums` | 24 / 32 | 600 |
| Section heading | `text-sm font-semibold` | 14 / 20 | 600 |
| Copy | `text-sm` | 14 / 20 | 400 |
| UI (rows, nav, controls) | `text-ui` | 13 / 18 | 400, 500 active |
| Meta, labels | `text-xs` | 12 / 16 | 400, 500 labels |
| Code, ids | `font-mono text-xs` | 12 / 16 | 400 |

Nothing below 12 px, no uppercase eyebrows, tabular figures for numbers, weights 400, 500 and 600
only.

Declared exception: screens in the Micro style (see Declared exceptions) are outside these rules.

### Radius, elevation, layers

| Material | Radius | Elevation | Examples |
|---|---|---|---|
| Control | 6 px (`rounded-md`) | none | Button, input, badge, nav item, row |
| Surface | 8 px (`rounded-lg`) | 1 px `border-line` | Section, table frame, code block |
| Floating | 12 px (`rounded-xl`) | `border-line` + `shadow-overlay` | Popover, menu, dialog, panel |
| Fullscreen | 16 px (`rounded-2xl`) | `shadow-dialog` | Command menu, large dialog |

Shadows only on floating surfaces, never colored.
z-index scale: `z-sticky` 10, `z-rail` 20, `z-panel` 50, `z-dialog` 60, `z-popover` 65,
`z-toast` 70, `z-tour` 80 (anchored overlays sit above the panels and dialogs they open from).

### Icons

lucide-react, 16 px (`size-4`, `strokeWidth={1.5}`), 14 px in dense rows. Nav items and icon
buttons get one; headings and cells usually do not. Icon-only buttons have an `aria-label` and a
tooltip.

### Motion

| Duration | Use |
|---|---|
| 120 ms | Hover color, press |
| 160 ms | Popover, menu, tooltip |
| 200 ms | Panel, dialog, sidebar collapse |

Enter with `ease-enter`, exit faster with `ease-exit`.

## Brand: pixel and dot-matrix

| Where | Use | Primitive |
|---|---|---|
| Empty and first-run states | The 5×5 mark at rest, in `fg-faint` | `EmptyState`, `DotEmblem` |
| A share next to its number | A row of square pixels beside the number | `DotMeter` |
| A trend under a stat | Columns of pixels per bucket, the latest coral | `DotSpark` |
| Canvases, maps, empty areas | A dot grid at 8 px pitch | `dot-grid`, `dot-grid-fade` |
| Status | A dot plus its word | `StatusDot` |
| Identity | The badger mark in the shell | `BadgerMark` |

Dots rest in `line` and `fg-faint`; coral lights only what is current. Never behind text,
tables or forms; aligned to the 4 px grid.

## Components

Built on Base UI where it has the part, styled with the tokens, merged with `cn`
(`@ratel/design-system/cn`) so `className` can override.

| Component | Use it for |
|---|---|
| `Button`, `IconButton` | Actions; one primary per view |
| `Input`, `Textarea`, `Select`, `Autocomplete`, `Checkbox`, `Switch`, `Field` | Forms |
| `Tabs`, `TabNav` | Sections of one page, each a URL |
| `SegmentedControl` | Switching views of the same data |
| `Badge`, `StatusDot` | Short metadata and status with a word |
| `Kbd` | Shortcut hints |
| `Tooltip` | Icon-only buttons, truncated values |
| `Popover`, `Menu` | Pickers, filters, row actions |
| `Dialog`, `ConfirmDialog` | Confirmations, forms of 5 fields or fewer |
| `Panel`, `PeekLink` | Inspecting an item without leaving its list |
| `Toaster` | Async results, Undo |
| `Page`, `PageHeader`, `PageBody` | Every page |
| `Section` | A titled group on a page |
| `StatRow`, `Stat` | 2 to 5 key numbers with deltas |
| `DataTable` | Every list of records |
| `Tree` | A hierarchy |
| `FilterBar`, `FilterChip`, `SearchInput` | Filtering a list |
| `EmptyState` | No data, no match, not set up |
| `Skeleton`, `Spinner` | Loading; a spinner only inside a pending button |
| `Callout` | One important notice per page at most |
| `Disclosure` | Detail on demand |
| `Steps` | An ordered sequence |
| `CodeBlock`, `CopyButton`, `KeyReveal` | Snippets, API keys shown once |
| `ShareBar` | A share of a whole as one stacked bar |
| `DotEmblem`, `DotMeter`, `DotSpark` | The brand marks |

### Overlays: which one

| Need | Use | Never |
|---|---|---|
| A row's detail, then back | **Panel** from the right, `?peek=<id>`, `j`/`k` to move | A centered modal |
| Longer than a screen, or worth sharing | A **page** | An endless panel |
| Confirm something irreversible | **Dialog**: the consequence in one sentence, a danger button named after the action | Nested dialogs |
| Short create or edit form | **Dialog**, Enter submits | Long forms |
| Pick a value, filter, row action | **Popover** or **Menu** | A dialog |
| Explain an icon, show a truncated value | **Tooltip** | Essential information |
| Result of an action | **Toast**, Undo when reversible | A confirmation dialog for a reversible save |

## Patterns

**Page anatomy.** PageHeader, at most one Callout, the answer (StatRow or the primary list),
then drill-downs.

**Lists.** FilterBar above, DataTable below; a row click or `Enter` opens the Panel; bulk actions
in a bar at the bottom.

**Numbers.** Labels `text-xs text-fg-subtle`, values `text-2xl font-semibold tabular-nums`,
deltas signed with an arrow and colored only when the direction is good or bad. Abbreviated in
stats with the suffix attached ("12.4K"), exact in tables. Counts in digits ("8 tools"); a unit
after a non-breaking space ("12 ms"). Money in whole amounts or cents, one or the other per view.

**Time.** Relative in lists with the absolute time in a tooltip, absolute in detail views; one
shared time-window control.

**Empty states.** In place of the data: a 20 px icon, a one-line title, one sentence, one
primary action, an optional docs link.

**Loading.** `Skeleton` for sections, `Button` with `loading` for actions.

**Errors.** A failing section shows a `Callout` in its own place; the rest of the page stays
usable.

**Forms.** Every control sits in a `Field`, which owns its label and its error.

**Destructive actions.** Deleting something that cannot come back asks for its name in a
`ConfirmDialog`. Anything that can come back happens at once, with Undo in the toast.

**Identifiers.** Mono, truncated in the middle, click to copy.

## Content and copy

- A button names what it does ("Create API key").
- **No em dashes** in copy, labels, tooltips, comments or docs.
- The nouns and the Glossary below are the vocabulary; a new term is added here first.

### The product's nouns

Intents, then Tasks, then Issues and Self-corrections, then Fixes: one word per concept.

| Noun | Means | Icon | Lives in |
|---|---|---|---|
| **Ask** | One thing a person asked (one turn) | | everywhere |
| **Conversation** | A person's asks in one session | `MessagesSquare` | Flows |
| **Intent** | Asks that want the same thing, named in plain words | `MessageSquareText` | Intents |
| **Flow** | What people want next, ask after ask | `Waypoints` | Intents › Flows |
| **Task** | The tools your agent runs for an ask, in order | `ListChecks` | Agent health › Tasks |
| **Steps** | A task's tools in order | `Footprints` | A task's page, an intent's panel |
| **Tool**, **Skill** | What the agent can call | `Wrench`, `BookOpen` | Catalog |
| **Issue** | Something going wrong, with numbers and a fix | `CircleAlert` | Agent health |
| **Self-correction** | The agent retried, switched tools, gave up or apologized | `RotateCcw` | Agent health › Self-corrections |
| **Fix** | A concrete change that resolves an issue | `Hammer` | Improvements › Fixes |

An intent opens onto **What they ask for**, then **Ways people ask it**. Nouns appear as pins
with their icon, and every page links to its neighbours.

### Glossary

| Internal term | UI term |
|---|---|
| Judge, model judge, classifier verdict | "Judged", never the engine name |
| Invoked, seen in traces | "Seen it run" |
| BM25 / embeddings ranking | "Keyword match" / "Semantic match" |
| Arm (served / shadow) | "Variant" (current / comparison) |
| Shadow ranking, calibration | "Experiment", "comparison" |
| Jaccard@k, overlap / top-1 agreement | "Agreement" / "Same first pick" |
| Recall@k, nDCG, MRR | Behind "Details" only |
| Cluster (intent graph) | "Ask group" on Adaptive ranking only |
| Intent graph | "Intent map" (the picture), "intents" (the concept) |
| `invoke_start`, `invoke_end`, `invoke_error` | "Tool call started / finished / failed" |
| `search`, `skill_search`, `gateway_search` | "Search" |
| `index_churn`, `skill_churn` / `events_dropped` | "Catalog changed" / "Events dropped" |
| Runtime events, facts lane | "SDK events" |
| Trace (root) | "Run" in lists, "Trace" in detail |
| Query intent, ask group on Intents, topic | "Intent" |
| Intent engine level 1 / level 0 / level 2 | "What they ask for" / "Ways people ask it" / not shown |
| Multi-intent frame | "Also wanted in the same ask" |
| Per-intent tool pattern | "Step by step" |
| Workflow, tool exploration, tool craft | "Task", its tools "Steps" |
| Craft proposal, match-quality proposal, suggestion | "Fix" |
| Signal, problem | "Issue" |
| Retry, switch, give-up, repeated ask, apology | "Self-correction" ("Retried", "Gave up", ...) |
| Backtest, retrieval replay | "Replay" |
| Playground | "Test a search" |

## Data visualization

A headline is a stat, a trend is a line or bars, a share is a `ShareBar`. No pies.

| Slot | `chart-1` | `chart-2` | `chart-3` | `chart-4` | `chart-5` | `chart-6` |
|---|---|---|---|---|---|---|
| Hue | blue | aqua | violet | yellow | magenta | green |
| Value | `#3987e5` | `#199e70` | `#9085e9` | `#c98500` | `#d55181` | `#008300` |

- Slots in order, never cycled; a seventh series is "Other"; color follows the entity.
- Sequential in blue, diverging blue to magenta; status colors are never series.
- 2 px lines, 4 px rounded bar ends, one y-axis.

## Baseline

WCAG 2.2 AA, every flow usable from the keyboard with `ring-focus` visible, one `h1` per page
(PageHeader). Pages render on the server; client code only where there is
interaction.

## Pull request checklist for UI changes

- [ ] Design-system primitives and semantic tokens only.
- [ ] Principles 2, 3, 6 and 7 hold; Baseline met.
- [ ] Screenshots of the empty and dense state, desktop and phone width.

## Declared exceptions

**The Micro style** is the look of the screens the Cloud app built before this design system, named
after its small mono type. Its palette is `forest`, `cream`, `canvas`, `base-deep`, `warm-muted` and
`indigo-300`. A Micro screen is identical to the Cloud app's, except for its name where this document renames it.
It is still built from this package's components, with its look passed through variants and
`className`. No new screen uses it.

| Screen | Status |
|---|---|
| Error pages, trace comparison | Here |
| Test a search (`/playground`) | Here |
| Experiment detail, mismatches, selection (`/calibration/...`) | To port |

| Rule set aside | What a Micro screen does |
|---|---|
| Coral marks the primary action and selection | The primary action and the selected method are filled with `fg`; the selected tab and filter are violet (`indigo-300`) |
| No uppercase, nothing below 12 px | Uppercase mono micro-labels, text from 9 px |
| Mono is for ids, code and keys | Counts, scores and meta are mono |
| Page anatomy, surfaces, radii | Its own title, cards with 16 px corners, its own tabs and filter chips |
| Glossary | Engine words as the Cloud app says them: BM25, Embeddings, Hybrid, Served, Shadow |

Variants for Micro screens, not for ordinary pages:

| Component | Addition |
|---|---|
| `Button` | `variant="inverse"`, `variant="outline"`, `size="xs"` |
| `SegmentedControl` | `variant="inverse"`, `disabled` and `title` on an option |
| `Tooltip` | `className`, `arrow` |
| `MenuGroup` | `labelClassName` |
| `DialogContent` | `titleClassName` |

`src/ratel.css` holds its palette mapping, global classes and animations: `description-split-enter`, `action-reveal-enter`,
`bench-swap-left`, `bench-swap-right`, `bench-settle`, `analyze-scan-fill`.

## Where things live

| What | Where |
|---|---|
| Palette, fonts, logo assets | `packages/brand` |
| Semantic tokens | `packages/design-system/src/styles.css` |
| Primitives | `packages/design-system/src/components/` |
| Console shell | `apps/web/app/(console)/layout.tsx` |
