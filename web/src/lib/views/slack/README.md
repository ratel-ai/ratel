# Slack

An organization's Slack app and its one connected workspace, for the alerts (`../alerts`). Behind the
`customMonitoring` flag. Core-owned.

| Table | Holds |
|---|---|
| `slack_apps` | the app an organization saved: its client id, and its secret sealed (migration 0053) |
| `slack_connections` | the connected workspace: its team, the bot token sealed, and when Slack refused it |

Both are keyed on the organization id, with no foreign key: the core has no organizations table.

| File | Holds |
|---|---|
| `types.ts`, `errors.ts` | what a page may know, and Slack's codes as a person reads them; safe for the browser |
| `app.ts` | the app to install (the edition's `slackApp` port, else the saved one), the scopes, the manifest link and the consent link |
| `app-actions.ts` | `changeSlackApp`: save and remove, for organization admins |
| `install.ts`, `state.ts` | Add to Slack and the callback; the state is sealed, for one person, for 10 minutes |
| `forget.ts` | `forgetOrganization`: ends the token and deletes both rows, when an edition deletes the organization (`CoreServices.forgetOrganization`) |
| `connection-actions.ts` | the channel list, and disconnect (admins) |
| `channels.ts` | the channel list, the access check, the post and the end of a token, with the bot token |
| `api.ts` | one Web API call with a deadline and no redirect, on `node:https` |
| `store.ts`, `workspace.ts` | the rows; only `readSlackApp` and `botTokenOf` open a secret |

Rules:

- The client secret, the token, the code and the state are never logged, never in an event, an error
  or an answer. An error keeps Slack's code only, when it reads as one.
- Only an organization admin connects or disconnects Slack, in the console and through MCP.
- An exchanged token that is not kept is ended in Slack (`auth.revoke`): a refused install, a failed
  save, or the second of two callbacks.
- A live connection is never replaced: disconnect first. A lost one may be.
- A token that Slack refuses, or that cannot be opened, is a lost connection.
- `chat:write.public` reaches the workspace's public channels. Any other channel needs an invite.
- The origin of the redirect URL is `APP_PUBLIC_URL`, else `BASE_URL`. Slack accepts https only.
- `SLACK_URL` is Slack's own address, another one for GovSlack.
