# Geography

The map widget of a dashboard shows a measure by country, or by region of one country. It needs `customMonitoring`.

## Where a location comes from

Ratel reads the location of a trace one time, as its spans arrive. It takes the first of these that a span, or its resource, carries:

| Attribute (default name) | Holds |
|---|---|
| `geo.country.iso_code`, `geo.region.iso_code` | an ISO 3166-1 alpha-2 country code, and an ISO 3166-2 region code (`US-CA`, or `CA`) |
| `geo.location.lat`, `geo.location.lon` | coordinates in degrees |
| `client.address` | an IP address |

A trace has the location of its root span, else of its first span with one. Each project can change the names in Settings > General > Location attributes. A change takes effect within one minute, for the traces that arrive from then on. An agent reads them with the MCP tool `get_location_attributes`. For an organization admin it changes them with `change_location_attributes`.

Coordinates give a country, and a state in the United States. An IP address gives the same. Regions of other countries come from `geo.region.iso_code` only. The map has shapes for the countries of the world and for the states of the United States. The regions of another country show as a table.

## Resolve IP addresses

IP addresses are resolved with the DB-IP Lite file. The file is not part of this repository. Without it, addresses are skipped, the other attributes still work, and the widget says so.

```bash
export GEO_DATABASE_PATH=/var/lib/ratel/geo.mmdb
pnpm --filter @ratel/platform geo:download           # countries and regions, about 130 MB
pnpm --filter @ratel/platform geo:download country   # countries only, about 8 MB
```

Set `GEO_DATABASE_PATH` for the processes that receive traces and for the ones that serve the console. The app takes a new file within one minute. DB-IP publishes a file each month: run the download again each month.

## What is stored

Only the codes: `ratel.geo.country` and `ratel.geo.region` on a located span, and `geo_country` and `geo_region` on its trace summary. An IP address and coordinates are in no stored row and in no log line. Settings refuse an address or a coordinate attribute whose name spans store (`gen_ai.*`, `ratel.*`, `server.address`). Where raw OTLP capture is on, the body of a trace export that carries an address is not kept. With the ingest queue on (`EXPERIMENTAL_INGEST_QUEUE=1`), the address and the coordinates are taken out of an export before it is queued. Raw capture of log exports does not read them: do not send an address in a log record.

Private and reserved addresses resolve to nothing.

## Licences

- **DB-IP Lite**: [IP Geolocation by DB-IP](https://db-ip.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The licence requires the attribution: the widget always shows it. Keep it where you show these results elsewhere.
- **world-atlas** 2.0.2 (ISC): boundaries of [Natural Earth](https://www.naturalearthdata.com), public domain. 105 KB in the browser, 739 KB on the server.
- **us-atlas** 3.0.1 (ISC): boundaries of the US Census Bureau, public domain. 112 KB.
