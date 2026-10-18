---
'lens': patch
---

`GET /prices/history` accepts `?format=csv`, returning the points as a
`text/csv` body (`ts,price,volume`, RFC 4180 quoting, LF endings, one trailing
newline); JSON stays the default and an unknown format is rejected with 400
before the database is queried. The serializer is `historyToCsv()` in
`src/api/history.ts`, and `tests/historical.golden.test.ts` byte-compares it —
plus the HTTP response — against `tests/fixtures/historical-*.csv`, so column
order, timestamp and number formatting, and line endings cannot drift without
failing the suite.
