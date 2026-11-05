# `lib/composition` (L0)

The composition root. `RATEL_COMPOSITION` (`oss`, the default, or `cloud`) selects which set of
port implementations is mounted; a missing port stops the process at startup
(`instrumentation.node.ts`), never on the first request.

- `index.ts` — `createComposition` and the `composition` singleton the core reads.
- `ui`, optional on a composition: what an edition adds to the root layout and the account menu, and
  the pages it puts in place of the open-source defaults (the rail switcher, `/organizations`,
  `/org/<slug>/team`, `/org/<slug>/billing`, the organization's General and Danger zone settings, `/` itself), the bar above the console and
  the boundary around each page, and the access gate around the console and `/onboarding`, which
  decides before the shell resolves its data. A loader, so the boot path never imports it. Absent
  in the open-source edition.
- `connect`, optional on a composition: `instrumentation.node.ts` calls it at startup with the
  core services (`CoreServices`), so the edition reads core data without importing a core module.
  Absent in the open-source edition.
- `organizationNav`: the organization pages an edition adds to the rail (Cloud: Members, Billing). The edition's optional `hiddenOrganizationNav(slug)` names paths to hide for one organization; the shell filters with it, and nothing is hidden without it.
- `ee-absent.ts` — what the `#ee-composition` alias resolves to when `ee/src` is absent: `null`.

With ADR-0030 the root splits in two: `ports.ts` (the ports; imports no module) and
`registry.ts` (collects every module's `register.ts`; the one file allowed to import any layer).
