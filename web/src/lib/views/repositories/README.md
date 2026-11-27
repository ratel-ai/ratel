# Repositories

A project's linked GitHub repository, the commits that make its versions, and the first rule that picks the evals a change touches (RTL-408). It is behind the `githubRepositories` flag. It is a draft, and nothing here is merged or deployed. The design and its open questions are in [`docs/github-repositories.md`](../../../../../docs/github-repositories.md).

| Table | Holds |
|---|---|
| `project_repositories` | A project's one linked repository. It holds GitHub's repository id (which survives a rename), its name, the App installation, the default branch, the version branch patterns, whether pull requests make versions, and the path of `ratel.yaml`. Migration 0059. |
| `repository_commits` | One row per commit that makes a version, or awaits approval to make one. It holds the base it compares with, the branch and the PR number. Its status is `queued`, `awaiting_approval`, `building`, `ready` or `failed`. It also holds the version it built, `sandbox_version_id`, which has no foreign key until `sandbox_versions` lands. Unlinking keeps the commits. |

| File | Holds |
|---|---|
| `schema.ts`, `store.ts` | The rows: link, unlink, the links of a repository (with their organization, for the flag), record a commit once, move a commit on, and the newest commits. |
| `webhook.ts` | The pure GitHub side: the signature check, the commit a `push` or `pull_request` delivery names, and whether that commit makes a version (`decideCommit`). |
| `receive.ts` | One delivery from start to end, with its dependencies injected. The route is `app/api/v1/github/webhook`. |
| `glob.ts` | The branch and path patterns: `**` crosses slashes, `*` and `?` do not, and a path pattern with no slash matches the file name. |
| `selection/` | `diff.ts` (the files of a unified diff) and `select.ts` (`selectEvals`: the evals, rows and traces a change touches, each with its reasons). The fixture diffs are in `fixtures/`. |

Rules:

- **No webhook secret:** without `GITHUB_WEBHOOK_SECRET` the route answers 404.
- **Signature first:** a delivery is checked against its `X-Hub-Signature-256` in constant time before its body is read.
- **Flag per project:** a commit is recorded only for projects with the flag on. A repository that only flag-off projects link answers like one nobody links. A flag read that fails counts as off.
- **Which commits:** the default branch and the listed patterns make versions. So does a pull request from the repository itself. A fork's pull request is recorded as `awaiting_approval` and never built on its own. A commit is recorded once, and a redelivery never moves it back.
- **No tokens:** no GitHub token is stored here. The App's installation tokens will be minted per use.
- **Who calls the selection:** `selectEvals` is pure. Its only caller will be the flag-gated build pipeline, once a version is ready.
