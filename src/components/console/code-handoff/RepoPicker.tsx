"use client";

import { Button } from "@ratel/design-system/button";
import { Select } from "@ratel/design-system/select";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { linkRepoAction } from "@/app/(console)/project/[projectId]/settings/repository/actions";
import { repositorySettingsPath } from "@/lib/views/code-handoff/paths";

/** Pick one of the installation's repos and link it. The grant from GitHub's redirect proves the installation. */
export function RepoPicker({
  projectId,
  grant,
  repos,
}: {
  projectId: string;
  grant: string;
  repos: { id: number; fullName: string }[];
}) {
  const router = useRouter();
  const [repoId, setRepoId] = useState<string>(repos.length === 1 ? String(repos[0].id) : "");
  const [busy, setBusy] = useState(false);

  if (repos.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        The App can reach no repository yet. Give it access to one on GitHub.
      </p>
    );
  }

  async function link() {
    setBusy(true);
    try {
      const result = await linkRepoAction(projectId, grant, Number(repoId));
      if (!result.ok) {
        toast({ title: "Couldn't link the repository", description: result.error, tone: "danger" });
        return;
      }
      toast({ title: "Repository linked", tone: "success" });
      router.replace(repositorySettingsPath(projectId));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Repository"
        placeholder="Choose a repository…"
        options={repos.map((repo) => ({ value: String(repo.id), label: repo.fullName }))}
        value={repoId}
        onValueChange={setRepoId}
        className="min-w-64"
      />
      <Button variant="primary" onClick={link} disabled={!repoId} loading={busy}>
        Link repository
      </Button>
    </div>
  );
}
