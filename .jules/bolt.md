## 2026-02-05 - Cached Prepared Statements in better-sqlite3
**Learning:** Reusing prepared statements in better-sqlite3 yields a ~6x performance improvement for frequent operations compared to re-preparing every time. SQLite also supports 'LIMIT -1' to mean 'no limit', allowing a single parameterized query to handle optional pagination.
**Action:** Always cache prepared statements in better-sqlite3 adapters, and use LIMIT -1/OFFSET 0 defaults to consolidate dynamic queries.
