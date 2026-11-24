"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Section } from "@ratel/design-system/section";
import { useState, useTransition } from "react";
import { checkModelsAction } from "@/app/(console)/org/[orgSlug]/settings/models/actions";
import type { ModelCheck } from "@/lib/console/settings/models";

const KIND_LABEL: Record<ModelCheck["kind"], string> = {
  text: "Text model",
  decision: "Decision model",
  embedding: "Embeddings",
};

/** Asks each kind of model once, on request: a few tokens on a hosted vendor. */
export function ModelCheckPanel({ slug }: { slug: string }) {
  const [results, setResults] = useState<ModelCheck[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const run = () =>
    startTransition(async () => {
      setFailed(false);
      try {
        setResults(await checkModelsAction(slug));
      } catch {
        setFailed(true);
      }
    });
  return (
    <Section
      title="Check"
      description="Makes one small call to each kind of model now. A hosted vendor charges a few tokens."
      actions={
        <Button size="sm" loading={pending} onClick={run}>
          Check now
        </Button>
      }
    >
      {failed ? <p className="text-ui text-danger">The check could not run. Try again.</p> : null}
      {results ? (
        <ul className="flex max-w-2xl flex-col gap-2 text-ui" aria-live="polite">
          {results.map((result) => (
            <li key={result.kind} className="flex items-start gap-3">
              <span className="w-28 shrink-0 text-fg-subtle">{KIND_LABEL[result.kind]}</span>
              <span className="shrink-0">
                {result.ok === true ? (
                  <Badge tone="success">Works</Badge>
                ) : result.ok === false ? (
                  <Badge tone="danger">Failed</Badge>
                ) : (
                  <Badge>Not called</Badge>
                )}
              </span>
              <span className="min-w-0 text-fg">
                {result.message}
                {result.ms !== undefined ? (
                  <span className="text-fg-subtle"> {result.ms} ms</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
