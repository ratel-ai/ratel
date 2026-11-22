# geo

`GeoIP2-Country-Test.mmdb`: MaxMind's test database, from
https://github.com/maxmind/MaxMind-DB/blob/main/test-data/GeoIP2-Country-Test.mmdb
(dual-licensed Apache-2.0 / MIT). It has the same record shape as the DB-IP
IP-to-Country Lite file the image ships (`country.iso_code`), so
`lib/otlp/dimensions/geo.test.ts` reads it through the real mmdb adapter. It knows
a few test networks only, for example 81.2.69.160 (GB), 216.160.83.56 (US),
89.160.20.112 (SE) and 2001:218::/32 (JP).
