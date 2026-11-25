import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GeographyChart } from "@/components/console/dashboards/GeographyChart";
import { geographyQuery } from "@/lib/contracts/query";
import type { GeographyResult } from "@/lib/synthesis/metrics/geography";
import { mapModel } from "@/lib/views/dashboards/geography-model";

function html(country: string | undefined, change: Partial<GeographyResult> = {}) {
  return renderToStaticMarkup(
    createElement(GeographyChart, {
      query: geographyQuery("trace_count", "count", { country }),
      result: {
        kind: "geography",
        places: [{ code: country ? `${country}-CA` : "US", value: 4, samples: 4 }],
        located: { traces: 4, matched: 6 },
        resolvesAddresses: false,
        ...change,
      },
      unit: "count",
      label: "Traces by country",
      valueLabel: "Traces",
      samplesLabel: "Traces",
    }),
  );
}

test("the attribution is always there, and how to resolve addresses only where they are not", () => {
  for (const text of [html(undefined), html("US"), html(undefined, { places: [] })]) {
    assert.match(text, /href="https:\/\/db-ip.com"[^>]*>IP Geolocation by DB-IP</);
    assert.match(text, /GEO_DATABASE_PATH/);
  }
  assert.doesNotMatch(html(undefined, { resolvesAddresses: true }), /GEO_DATABASE_PATH/);
});

test("without a database file the geo-attribute data is drawn, and its share is told", () => {
  const text = html(undefined);
  assert.match(text, /4 of 6 traces have a location/);
  assert.match(text, /Show as table/);
  assert.doesNotMatch(text, /No location in this time range/);
});

test("a country without a map is a table, and no place at all is an empty state", () => {
  const table = html("CA");
  assert.match(table, /<table/);
  assert.match(table, /There is no map of the regions of Canada/);
  assert.match(html(undefined, { places: [] }), /carry no location/);
  const none = { places: [], located: { traces: 0, matched: 0 } };
  assert.match(html(undefined, none), /No trace matches/);
});

test("the scale starts at 0 and has five steps", () => {
  const place = (code: string, value: number | null) => ({ code, value, samples: 1 });
  const { stepOf, max } = mapModel([
    place("A", 10),
    place("B", 1),
    place("C", 0),
    place("D", null),
  ]);
  assert.equal(max, 10);
  assert.deepEqual(
    [...stepOf],
    [
      ["A", 5],
      ["B", 1],
      ["C", 1],
    ],
  );
  assert.deepEqual([...mapModel([place("A", 0)]).stepOf], [["A", 1]]);
});
