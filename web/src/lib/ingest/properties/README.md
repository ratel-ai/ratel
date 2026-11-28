# `lib/ingest/properties` (L2)

Trace properties (RTL-395, [ADR-0012](../../../../../docs/adr/0012-trace-properties-storage.md)):
which attribute keys a project's traces carry, and the value of the
indexed ones on each span. A property is **detected** when ingest saw its key name, and
**indexed** when Ratel stores its values. Its source is **standard** (the curated list) or
**user** (a key of the project's own).

| Path | Holds |
|---|---|
| `standard.ts` | `STANDARD_PROPERTIES`: the canonical names and the attribute keys that give them, in priority order. `user` (`end_user_id`), `session` (`session_id`), `environment` (`environment`), `model` (`models`) and `service` (`service_name`) are summary columns already and are never stored twice; `organization` (organization, tenant, customer and account ids) and `release` (`service.version`, `app.version`, `release`) go in `properties`. Each spelling under the metadata prefixes of the conventions `SESSION_KEYS` and `USER_KEYS` read counts too. `standardPropertyOf(key)`, `standardProperty(name)` |
| `keys.ts` | pure: `detectPropertyKeys(spans)` (the scalar keys of an export, a resource counted once; never `gen_ai.*`, `ratel.*`, a key spans store, instrumentation, content, a credential or a location; at most `MAX_KEY_LENGTH` 100), `propertyValues(spans, names)` (each span's own value, then its ancestors', then its resource's, cut to `MAX_VALUE_LENGTH` 256, as text), `storedPropertyNames(names)` (the names without a summary column) |
| `schema.ts` | `trace_property_keys` (migration `0063`): project, name, state, source, first and last sight, approximate count, `indexed_at` (kept when a property stops, cleared when its values are erased) |
| `store.ts` | `recordPropertyKeys` (one statement under a per-project lock: at most `MAX_DETECTED_KEYS` 200 keys of the user's own; a new standard key starts indexed; a state is never changed), `listTraceProperties(projectId)` (the read the settings section, the MCP tools and the later filter pages use: indexed first, with each standard property's `column`), `findTraceProperty`, `loadIndexedProperties`, `loadStoredPropertyNames(projectId, db)` (one statement: the names `properties` holds, indexed and detected, the most seen first, without the column properties; what RQL, `runQuery` and `describe_rql_schema` read), `countUserIndexed`, `setTracePropertyState`, `clearIndexedAt` |
| `ingest.ts` | `propertyIngest.capture(projectId, spans)`, wired as the `properties` dep of the traces route and the queue's worker (`otlp/ingest-spans.ts` passes the values to `otel_spans.properties`; a failure stores the spans without values). At most one key write per export, none for keys this process wrote in the last hour (their sightings are added to the next write); the indexed names are read once a minute per project. A standard property it indexes at first sight queues the fill |
| `fill.ts` | `FILL_TRACE_PROPERTIES_JOB` (`fill_trace_properties`) and `enqueuePropertyFill`: the job `synthesis/traces/register.ts` runs with `synthesis/traces/property-backfill.ts` |
| `actions.ts` | `changeTraceProperty(projectId, { action: "index" \| "stop" \| "erase", name, erase? }, deps)`: an organization admin, outside a support session. Indexing a key of the user's own needs the entitlement `maxIndexedPropertiesPerProject` (Cloud's plans; unlimited in the open-source edition), at most `MAX_USER_INDEXED` 20 whatever the plan answers; a standard property is indexed on every plan. Stop keeps the stored values until an erase; a column-backed standard property cannot be stopped. The console's `settings/property-actions.ts` and MCP's `change_trace_property` both call it, with `synthesis/traces/property-storage.ts` |
| `test-support.ts` | the export and the route call the integration tests share |

## What is stored, and how to turn it off

The key names of every project's traces (`trace_property_keys`); the values of the standard
properties, automatically; the values of a key of the project's own only after a person indexes
it (`otel_spans.properties`, `otel_trace_summaries.properties`). Settings > General > Trace properties (or
`change_trace_property`) stops a property, and erases its stored values from every span and trace
summary of the project. `pnpm backfill:trace-properties --project <id> [--apply]` fills the
traces the raw store still holds by hand.
