import { expect, test } from "bun:test"
import { openDashboardDatabase } from "../../src/server/storage/database"

test("migrates in-memory database and enables WAL pragmas", () => {
  const db = openDashboardDatabase(":memory:")
  const tables = db.query<{ name: string }, []>("select name from sqlite_master where type = 'table' order by name").all()
  expect(tables.map((row) => row.name)).toContain("schema_migrations")
  expect(tables.map((row) => row.name)).toContain("provider_cache")
  expect(tables.map((row) => row.name)).toContain("provider_history_events")
  expect(tables.map((row) => row.name)).toContain("provider_import_state")
  db.close()
})
