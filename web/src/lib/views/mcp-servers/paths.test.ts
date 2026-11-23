import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mcpServerCatalogHref,
  mcpServerClientsHref,
  mcpServerHref,
  mcpServersHref,
  mcpServerTracesHref,
  parseMcpRole,
  parseMcpServerKey,
} from "./paths";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ROOT = `/project/${PROJECT}`;

test("the list keeps the window and the environment", () => {
  assert.equal(mcpServersHref(PROJECT), `${ROOT}/mcp`);
  assert.equal(
    mcpServersHref(PROJECT, { range: "7d", environment: "prod" }),
    `${ROOT}/mcp?range=7d&facetEnvironment=prod`,
  );
  assert.equal(
    mcpServersHref(PROJECT, { range: "custom", from: "2026-11-01", to: "2026-11-02" }),
    `${ROOT}/mcp?range=custom&from=2026-11-01&to=2026-11-02`,
  );
});

test("the detail encodes the server key in the path, and the role in the query", () => {
  assert.equal(mcpServerHref(PROJECT, "docs-mcp"), `${ROOT}/mcp/docs-mcp`);
  assert.equal(
    mcpServerHref(PROJECT, "acme/tools v2", { role: "consumed", range: "30d" }),
    `${ROOT}/mcp/acme%2Ftools%20v2?role=consumed&range=30d`,
  );
  assert.equal(parseMcpServerKey("acme%2Ftools%20v2"), "acme/tools v2");
  assert.equal(parseMcpServerKey("100%"), "100%", "a malformed escape is the key as it is");
});

test("only the two roles parse", () => {
  assert.equal(parseMcpRole("provided"), "provided");
  assert.equal(parseMcpRole("consumed"), "consumed");
  assert.equal(parseMcpRole("other"), undefined);
  assert.equal(parseMcpRole(["consumed"]), "consumed");
  assert.equal(parseMcpRole(undefined), undefined);
});

test("Traces opens Turns filtered by the server, in the same window and environment", () => {
  assert.equal(
    mcpServerTracesHref(PROJECT, "docs-mcp", { range: "7d", environment: "prod" }),
    `${ROOT}/traces/turns?facetServer=docs-mcp&range=7d&facetEnvironment=prod`,
  );
});

test("Clients and Catalog are filtered by the server", () => {
  assert.equal(mcpServerClientsHref(PROJECT, "acme/tools"), `${ROOT}/clients?server=acme%2Ftools`);
  // The Catalog's search matches a tool group by its label, the server name (`lib/catalog/v2/tree.ts`).
  assert.equal(mcpServerCatalogHref(PROJECT, "github"), `${ROOT}/catalogs?q=github`);
});
