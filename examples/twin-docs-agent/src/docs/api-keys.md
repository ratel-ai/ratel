# API keys

Every project has its own API keys. A key reaches only its one project.

1. Open **Settings > API keys** in the console and create a key. It is shown once: copy it.
2. Send it as `Authorization: Bearer <key>` on every request to the ingest and catalog APIs.

Keys start with `rtl_`. A request with a missing, revoked or mistyped key gets `401 Unauthorized`. A key of another project gets `404` for that project's data. Rotate a key by creating a new one, switching your agent to it, then revoking the old one.
