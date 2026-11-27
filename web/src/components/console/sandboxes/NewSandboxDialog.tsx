"use client";

import { Button } from "@ratel/design-system/button";
import { CodeBlock } from "@ratel/design-system/code";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Steps } from "@ratel/design-system/steps";
import Link from "next/link";
import { useState } from "react";

/** A short `ratel.yaml`: the sandbox name, the image, the input, the params, the tools, the secrets. */
const RATEL_YAML = `name: support-agent
image:
  dockerfile: Dockerfile
input:
  example: { message: "Where is my order 7?" }
params:
  model:
    type: enum
    options: [small, large]
    default: small
tools:
  refund_order: { mode: simulated }
secrets: [OPENAI_API_KEY]`;

const DOCKERFILE = `FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# The agent answers HTTP on the port of run.port (8080 when not set).
EXPOSE 8080
CMD ["node", "server.js"]`;

/**
 * How a sandbox comes to exist: a push from the folder of the agent. The dialog only explains; it
 * creates nothing. The values are the real ones of this project and this server.
 */
export function NewSandboxDialog({
  projectId,
  projectName,
  ratelUrl,
}: {
  projectId: string;
  projectName: string;
  /** The public address of this server. */
  ratelUrl: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>New sandbox</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="New sandbox"
          description={`A sandbox is the image of your agent. A push from its folder makes the sandbox in ${projectName}, and each next push makes a new version.`}
          className="max-w-2xl"
          footer={<DialogClose render={<Button variant="secondary" />}>Close</DialogClose>}
        >
          <NewSandboxSteps projectId={projectId} projectName={projectName} ratelUrl={ratelUrl} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The three steps of the dialog, with the address of this server and the project name. */
export function NewSandboxSteps({
  projectId,
  projectName,
  ratelUrl,
}: {
  projectId: string;
  projectName: string;
  ratelUrl: string;
}) {
  const push = `export RATEL_BASE_URL=${ratelUrl}/api/v1\nexport RATEL_API_KEY=<a key of ${projectName} with full access>\nratel push`;
  return (
    <Steps
      label="Make a sandbox"
      steps={[
        {
          id: "ratel-yaml",
          state: "current",
          title: (
            <>
              Add <code className="font-mono">ratel.yaml</code> to the folder of your agent
            </>
          ),
          description:
            "Its name is the name of the sandbox. It declares the input, the params, the tools and the secret names.",
          children: <CodeBlock samples={[{ label: "ratel.yaml", code: RATEL_YAML }]} />,
        },
        {
          id: "dockerfile",
          state: "todo",
          title: "Add a Dockerfile next to it",
          description: "Ratel builds the image from it and starts your agent with its command.",
          children: <CodeBlock samples={[{ label: "Dockerfile", code: DOCKERFILE }]} />,
        },
        {
          id: "push",
          state: "todo",
          title: (
            <>
              Run <code className="font-mono">ratel push</code>
            </>
          ),
          description: (
            <>
              Use a key of this project from{" "}
              <Link href={`/project/${projectId}/settings/api-keys`} className="underline">
                API keys
              </Link>
              . The sandbox shows in this list when the push ends.
            </>
          ),
          children: <CodeBlock samples={[{ label: "Shell", code: push }]} />,
        },
      ]}
    />
  );
}
