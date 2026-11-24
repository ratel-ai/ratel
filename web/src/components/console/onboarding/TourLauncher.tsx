"use client";

import { Button } from "@ratel/design-system/button";
import { Compass } from "lucide-react";
import { useState } from "react";
import { finishOnboardingTourAction } from "@/app/(console)/tour-actions";
import { GuidedTour } from "@/components/console/onboarding/GuidedTour";
import type { OnboardingTourStatus } from "@/lib/console/onboarding/tour-state";

/**
 * Owns whether the tour is running, and offers a way back into it.
 *
 * A tour that can only ever be seen once is a tour people skip on their first
 * loaded page, when they are still working out what the product is, and then
 * cannot get back to on their third day, when the question finally matters. So
 * finishing it persists (the offer stops being automatic) but the button
 * stays put.
 *
 * Remounting via `runId` rather than resetting `GuidedTour`'s internals: the
 * tour resolves which steps can run once, at mount, and a re-run may face a
 * different page than the first run did.
 *
 * A re-run DOES rewrite the stored status, because the column records how the
 * user left the tour most recently, and either value keeps the auto-offer off.
 *
 * `record={false}` (an admin support session) keeps the tour fully usable but
 * never sends the outcome: the operator is not the one being onboarded, and a
 * read-only session would refuse the write anyway.
 */
export function TourLauncher({
  autoStart,
  isDemoProject,
  surface,
  record = true,
}: {
  autoStart: boolean;
  isDemoProject: boolean;
  surface: string;
  record?: boolean;
}) {
  const [runId, setRunId] = useState(autoStart ? 1 : 0);
  const [running, setRunning] = useState(autoStart);

  async function handleFinish(
    status: OnboardingTourStatus,
    detail: { lastStepId: string; stepsViewed: number },
  ) {
    setRunning(false);
    if (!record) return;
    try {
      await finishOnboardingTourAction(status, detail.lastStepId, detail.stepsViewed);
    } catch {
      // The tour has already closed and the outcome is analytics + a "do not
      // offer again" hint. Failing to record it must not resurface the tour or
      // surface an error to somebody who just finished reading it. The next
      // page load simply offers it once more.
    }
  }

  function start() {
    setRunId((current) => current + 1);
    setRunning(true);
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={start} aria-haspopup="dialog">
        <Compass aria-hidden />
        Take the tour
      </Button>
      {running && (
        <GuidedTour
          key={runId}
          offer
          isDemoProject={isDemoProject}
          surface={surface}
          onFinish={handleFinish}
        />
      )}
    </>
  );
}
