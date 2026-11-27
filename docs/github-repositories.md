# Connect a GitHub repository (design note, RTL-408)

**Status:** proposed. Marcello has not agreed it yet. It becomes an ADR once he does.
**Flag:** `githubRepositories` (`FF_GITHUB_REPOSITORIES`). It is off by default and gates every surface below.
**Comes after:** the eval core (RP-308: sandboxes, `ratel push`, datasets, evals, runs, baseline), which is still in open PRs (#487 → #509 → #518–#522).

## Goal

A project links its GitHub repository. Ratel builds the agent from the code, with no `ratel push` by hand. Each new commit becomes a new version. Ratel works out what changed and runs only the evals, the dataset rows and the past traces that best test that change.

Today a version comes only from `ratel push` of a local Docker image. The push stores the git commit (`sandbox_versions.git_commit`), but nothing reads it.

## The flow

```
GitHub ──push / pull_request──▶ POST /api/v1/github/webhook ──▶ repository_commits (queued)
                                                                        │
                            builder: source tarball → build VM → image  │
                                                                        ▼
                       the push path: prepare VM, smoke check, snapshot → sandbox_versions (ready)
                                                                        │
       compare base...head → diff → selectEvals() → suite run of the chosen evals, rows and traces
                                                                        │
                                       version page (later: a check run and a PR comment)
```

## 1. How Ratel reaches the repository

| Option | For | Against |
|---|---|---|
| **GitHub App** (recommended) | Installed per repository, with narrow permissions. Its installation tokens last one hour and are minted when needed, so none is stored. Webhooks come with it. It acts as a bot, not as a person, so it keeps working when someone leaves. Checks and PR comments come later with the same install. | A self-hosted deployment has to create its own App. One-time setup. |
| OAuth App | Simple sign-in. | A person's token with the broad `repo` scope. It stops working when that person leaves. Webhooks are separate. |
| Fine-grained token | Nothing to install. | A long-lived secret for each project, which expires and is renewed by hand. No webhooks. |

**Recommended:** a GitHub App, set up the way Slack is today. Cloud supplies Ratel's App through an edition port. The open-source edition reads its own App from config (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`).

Permissions:

- **Now:** Metadata read, Contents read, Pull requests read.
- **Later:** Checks write and Pull requests write, for the results on the PR.

**Webhooks:**

- `push` and `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`) make versions.
- `installation` and `installation_repositories` keep the links true when access is removed.

**Which commits make versions:**

- The head commit of a push to the default branch, plus the branch patterns the link lists (`release/*`).
- The head commit of a pull request from the same repository, compared with its base.
- A fork's pull request is recorded as `awaiting_approval` and never built on its own.
- Tags, deleted branches and every other event are ignored.
- One commit is one version, whether a push or a pull request named it.

## 2. How the agent is built from source

| Option | For | Against |
|---|---|---|
| **A. Our builder on the sandbox VMs** (recommended) | Nothing to set up in the customer's repository. It reuses the VM provider, the prepare VM, the smoke check and the snapshot of #487. | A build costs us VM time. A build that needs private registries or secrets needs more work. |
| B. GitHub Actions runs `ratel push` | It works today, with no new infrastructure. Build secrets stay in the customer's CI. GitHub already keeps secrets from fork PRs. | It needs a workflow file and a Ratel key in their repository secrets. It is not "connect and go". |
| C. Pull from a registry (GHCR, ECR) | No build at all. | Registry credentials for each project, and the customer must already publish images. |

**Recommended:** A as the default, with B kept and documented as the escape hatch for builds that need secrets. C comes later, if someone asks for it.

The builder for A:

1. The Ratel server fetches the source tarball at the commit (`GET /repos/{o}/{r}/tarball/{sha}`) with an installation token. The token never enters a VM.
2. A **build VM** gets the tarball and runs `docker build` with the link's `configPath` and its Dockerfile. It gets no secret, takes no snapshot, has an outbound allow-list limited to package registries, and has a time and size cap.
3. `docker save` produces the image. From there it is the push path of #487: a prepare VM loads the image and saves the snapshot, and a smoke VM checks it.
4. The commit row moves `queued` → `building` → `ready` (with its `sandbox_version_id`) or `failed` (with the build log).

This keeps the rule of RP-391 (no snapshot of a VM that saw a secret) without a new exception.

## 3. Change → eval selection

The first rule is pure and explainable. It reads only the diff. It is `selectEvals` in [`web/src/lib/views/repositories/selection/select.ts`](../web/src/lib/views/repositories/selection/select.ts), with tests on fixture diffs.

**Inputs:**

- The unified diff from base to head, from GitHub's compare API in diff format. A push compares with the branch's previous head, and a PR with its base.
- The tools the version declares, from its `ratel.yaml`.
- Each eval, with the tools it exercises (its rows' expected calls, the checks that name a tool, and its traces' calls), and optionally the prompts and paths it covers.
- Recent traces, with the tools they called.

**Per file**, the first rule that applies:

1. `ratel.yaml`: a line that names a declared tool changes that tool. Any other line (model, params, input, secrets) changes every run.
2. A build file (Dockerfile, a dependency manifest or lockfile) or a system prompt: changes every run.
3. A prompt file (`**/prompts/**`, `*.prompt.*`): changes the prompt with that file name.
4. Docs, CI and tests: change nothing the agent runs.
5. Any other file: changes each declared tool that its path or its changed lines name. `refundOrder` names `refund_order`. The file is also covered by each eval whose `paths` match it. A file that neither maps is **unmapped**.

**Then:**

- A global change, an unmapped file, or a prompt no eval names runs **every** eval and row. Missing a regression costs more than a few extra runs.
- Otherwise an eval runs when a changed tool, prompt or path picks it.
  - When a tool picks it, only the rows that use that tool run.
  - When a prompt or a path picks it, all its rows run.
- Docs-only changes run nothing.
- A changed tool that no eval uses is named as **untested**: a gap the page shows.
- The traces to replay are the recent ones that called a changed tool, 20 at most.

Each pick says why ("uses refund_order", "covers src/persona/voice.ts"). The version page shows the reasons.

**Later:** match spans and code paths (a call graph from the agent's entry point to each tool), learn which files moved which scores, and let a person pin evals that always run.

## 4. Where results go

1. **First, the Ratel version page:** the commit, what changed, the evals chosen with their reasons, and the results against the baseline.
2. **Later, a GitHub check run on the commit:** pass, fail or neutral, with a link to the page.
3. **Later, a PR comment** that is updated in place, never one comment per push.

## 5. Security

- **Webhooks:** each delivery's `X-Hub-Signature-256` is checked in constant time before its body is read. Without `GITHUB_WEBHOOK_SECRET` the route answers 404. A repository that only flag-off projects link answers like one nobody links.
- **Linking:** only a project admin links a repository, and only one that the App's installation reaches. Ratel checks this with an installation token when the link is made, so nobody can claim another organization's repository id.
- **Tokens:** installation tokens are minted per use and never stored, logged or passed to a VM.
- **Builds:** no secrets, no snapshot, a registry-only outbound allow-list, and time and size caps. Sandbox secrets still reach only the run VMs, as in #487.
- **Fork PRs:** never built or run until a project admin approves that commit. Their code would run with the project's sandbox secrets, such as the model key.
- **Commit text:** a commit title is stored capped at 200 characters and shown as text, never as HTML.

## 6. What the foundations PR lays (draft, no merge, no deploy)

- **Flag:** `githubRepositories` (`FF_GITHUB_REPOSITORIES`), off by default.
- **Table `project_repositories`:** a project's one linked repository. It holds the GitHub repository id, the installation, the default branch, the version branch patterns, whether PRs make versions, and the path of `ratel.yaml`.
- **Table `repository_commits`:** one row per commit that makes (or awaits approval to make) a version. It holds the base it compares with, the status, and `sandbox_version_id`. That column has no foreign key until `sandbox_versions` lands with the eval core.
- **Route `POST /api/v1/github/webhook`:** verifies the delivery, reads push and pull_request, decides per project, and records the commit only for projects with the flag on.
- **`selectEvals`:** the first selection rule, with fixture diffs.

**Not in it yet:**

- The App install and link flow, in the console and over MCP.
- The builder.
- The compare-API fetch.
- The adapter from eval definitions to `EvalTarget`.
- The version page.

## Open questions

1. **Build path:** is A (our builder) the default, or do we ship B (Actions + `ratel push`) first because it needs no new infrastructure?
2. **Cost:** who pays for build VM time? Does it count toward `sandbox_vm_starts_per_day`, or get a limit of its own?
3. **Repositories per project:** one, or several? Today it is one. A monorepo with several agents can link the same repository from several projects through `configPath`.
4. **Branches:** does a PR from the same repository make a version by default, or only once someone opts in?
5. **Unmapped changes:** is "run everything" the right answer, or should it run a smoke set with a note?
6. **Who approves a fork's PR:** project admins only? Is the approval per commit, or per PR until the next push?
7. **Migration numbering:** the stack's 0059–0066 collide with this PR's 0059. Whichever merges second regenerates. The `sandbox_version_id` foreign key comes with that.
8. **Deploys:** none to staging or prod before Berca's migration ends (2026-11-27 or later).
