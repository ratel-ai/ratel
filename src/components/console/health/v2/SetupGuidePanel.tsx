"use client";

import { CodeBlock } from "@ratel/design-system/code";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useEffect, useRef, useState } from "react";
import {
  CAPTURE_DIFF_LINES,
  otelCaptureDiffLines,
} from "@/components/console/health/capture-nudge-model";
import {
  type SetupCardModel,
  type SetupPill,
  setupPill,
} from "@/components/console/health/setup-card-model";
import { type SetupStack, STACK_LABEL } from "@/components/console/health/setup-guides";
import type { CaptureNudgeInput } from "@/components/console/health/v2/setup-nudge";
import {
  CAPTURE_GUIDE,
  peekedSetup,
  type SetupGuideKey,
} from "@/components/console/health/v2/setup-peek";
import { track } from "@/lib/platform/track-client";
import { productWords } from "@/lib/views/fixes/copy";

/**
 * How to turn one data point on, in a Panel (`?peek=setup:<key>`): what it
 * adds, the snippet for the reader's stack, and what already arrives. Opened
 * from the setup callout and from the sections that need the data point.
 * The first guide opened in a page view is counted, as the card's was.
 */
export function SetupGuidePanel({
  projectId,
  card,
  nudge,
  captureLevel,
}: {
  projectId: string;
  card: SetupCardModel | null;
  nudge: CaptureNudgeInput | null;
  captureLevel: CaptureNudgeInput["captureLevel"];
}) {
  const peek = usePeek();
  const key = peekedSetup(peek.id);
  const [shown, setShown] = useState<SetupGuideKey | null>(key);
  if (key && key !== shown) setShown(key);
  const tracked = useRef(false);
  useEffect(() => {
    if (!key || tracked.current) return;
    tracked.current = true;
    track("content_capture_enabled_from_nudge", {
      project_id: projectId,
      capture_level: captureLevel,
      unlock_count: card?.missing ?? nudge?.unlocks.length ?? 0,
    });
  }, [key, projectId, captureLevel, card, nudge]);

  const pills = card?.groups.flatMap((group) => group.pills) ?? [];
  const pill =
    shown && shown !== CAPTURE_GUIDE
      ? (pills.find((each) => each.key === shown) ??
        setupPill({ key: shown, status: "off", share: 0 }))
      : null;
  const title = pill
    ? pill.label
    : nudge?.mode === "otel"
      ? "OpenTelemetry options"
      : "Content capture";
  return (
    <Panel
      open={key !== null}
      onOpenChange={(next) => {
        if (!next) peek.close();
      }}
      title={title}
      subtitle={pill ? pill.statusText : "What it adds, and the change"}
    >
      {pill ? (
        <Guide pill={pill} received={card?.received ?? []} />
      ) : shown === CAPTURE_GUIDE ? (
        <CaptureGuide nudge={nudge} />
      ) : null}
    </Panel>
  );
}

/** One data point's guide; the stack the reader picks is kept across guides while it applies. */
export function Guide({
  pill,
  received = [],
}: {
  pill: SetupPill;
  received?: readonly SetupPill[];
}) {
  const [stack, setStack] = useState<SetupStack | null>(null);
  const guide = pill.guides.find((each) => each.stack === stack) ?? pill.guides[0];
  return (
    <div className="flex flex-col gap-4" data-setup-guide={pill.key}>
      <p className="text-ui text-fg">{productWords(pill.unlocks)}</p>
      {pill.guides.length > 1 && guide ? (
        <SegmentedControl
          label="Your stack"
          value={guide.stack}
          onValueChange={setStack}
          options={pill.guides.map((option) => ({
            value: option.stack,
            label: STACK_LABEL[option.stack],
          }))}
          className="self-start"
        />
      ) : null}
      {guide ? (
        <>
          <CodeBlock
            samples={[{ label: STACK_LABEL[guide.stack], code: guide.code }]}
            caption={STACK_LABEL[guide.stack]}
          />
          {guide.note ? <p className="text-xs text-fg-subtle">{guide.note}</p> : null}
        </>
      ) : null}
      {received.length > 0 ? (
        <p className="border-t border-line pt-3 text-xs text-fg-subtle" data-setup-received="">
          Already received: {received.map((each) => each.label).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/** What content capture (or the OpenTelemetry options) adds, and the lines to change. */
function CaptureGuide({ nudge }: { nudge: CaptureNudgeInput | null }) {
  if (!nudge) return null;
  const otel = nudge.mode === "otel";
  const lines = otel
    ? otelCaptureDiffLines(nudge.unlocks.map((unlock) => unlock.key))
    : CAPTURE_DIFF_LINES;
  const code = lines.map((line) => `${line.added ? "+ " : "  "}${line.text}`).join("\n");
  return (
    <div className="flex flex-col gap-4" data-setup-guide={CAPTURE_GUIDE}>
      <ul className="flex flex-col gap-2">
        {nudge.unlocks.map((unlock) => (
          <li key={unlock.key} className="flex flex-col">
            <span className="text-ui text-fg">{unlock.label}</span>
            <span className="text-xs text-fg-subtle">{productWords(unlock.description)}</span>
          </li>
        ))}
      </ul>
      <CodeBlock samples={[{ label: "Diff", code }]} caption="Where you set up tracing" />
      <p className="text-xs text-fg-subtle">
        {otel
          ? "Names differ a little between instrumentations: OpenInference and Traceloop read session.id, for example."
          : "Using ratel-local? Set privacy to Tool details or Full content instead."}
      </p>
    </div>
  );
}
