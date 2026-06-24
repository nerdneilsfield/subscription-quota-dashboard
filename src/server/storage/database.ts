import { Database } from "bun:sqlite"
import { MIGRATIONS } from "./schema"

export type DashboardDatabase = Database

export function openDashboardDatabase(path: string): DashboardDatabase {
  const db = new Database(path, { create: true })
  db.exec("pragma journal_mode = WAL")
  db.exec("pragma busy_timeout = 5000")
  db.exec("pragma foreign_keys = ON")
  db.exec("create table if not exists schema_migrations(version integer primary key, applied_at text not null)")
  for (const migration of MIGRATIONS) {
    const exists = db.query("select 1 from schema_migrations where version = ?").get(migration.version)
    if (!exists) {
      db.transaction(() => {
        db.exec(migration.sql)
        db.query("insert into schema_migrations(version, applied_at) values (?, ?)").run(migration.version, new Date().toISOString())
      })()
    }
  }
  return db
}
