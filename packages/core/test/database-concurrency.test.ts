import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../src/database/sqlite.bun"
import { tmpdir } from "./fixture/tmpdir"

test.each([25, 6000])(
  "a competing writer yields until a %d ms lock is released",
  async (delay) => {
    await using dir = await tmpdir()
    const filename = `${dir.path}/concurrent.db`
    const owner = new Database(filename)
    owner.run("PRAGMA journal_mode = WAL")
    owner.run("CREATE TABLE writes (id INTEGER PRIMARY KEY)")
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* SqlClient
          owner.run("BEGIN IMMEDIATE")
          owner.run("INSERT INTO writes VALUES (1)")
          const release = setTimeout(() => owner.run("COMMIT"), delay)
          yield* client.unsafe("INSERT INTO writes VALUES (2)").pipe(
            Effect.ensuring(
              Effect.sync(() => {
                clearTimeout(release)
                if (owner.inTransaction) owner.run("ROLLBACK")
              }),
            ),
          )
          expect(owner.query("SELECT count(*) AS n FROM writes").get()).toEqual({ n: 2 })
        }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
      )
    } finally {
      owner.close()
    }
  },
  10_000,
)

test("eight processes commit 800 transactions without lost or duplicated writes", async () => {
  await using dir = await tmpdir()
  const filename = `${dir.path}/parallel.db`
  const owner = new Database(filename)
  owner.run("PRAGMA journal_mode = WAL")
  owner.run("CREATE TABLE writes (id INTEGER PRIMARY KEY)")
  owner.run("CREATE TABLE counter (n INTEGER NOT NULL)")
  owner.run("INSERT INTO counter VALUES (0)")
  const workers = Array.from({ length: 8 }, (_, i) =>
    Bun.spawn([process.execPath, `${import.meta.dir}/fixture/database-writer.ts`, filename, String(i)], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  try {
    const results = await Promise.all(
      workers.map(async (worker) => ({
        code: await worker.exited,
        error: await new Response(worker.stderr).text(),
      })),
    )
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, error: "" })))
    expect(owner.query("SELECT count(*) AS n FROM writes").get()).toEqual({ n: 800 })
    expect(owner.query("SELECT n FROM counter").get()).toEqual({ n: 800 })
    expect(owner.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  } finally {
    workers.forEach((worker) => worker.kill())
    await Promise.all(workers.map((worker) => worker.exited))
    owner.close()
  }
}, 30_000)

test("constraint errors retain SQLite details and are not retried", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* SqlClient
      yield* client.unsafe("CREATE TABLE writes (id INTEGER PRIMARY KEY)")
      yield* client.unsafe("INSERT INTO writes VALUES (1)")
      const start = performance.now()
      const result = yield* client.unsafe("INSERT INTO writes VALUES (1)").pipe(Effect.flip)
      expect(result.message).toContain("SQLITE_CONSTRAINT")
      expect(result.message).toContain("errno=1555")
      expect(performance.now() - start).toBeLessThan(1000)
    }).pipe(Effect.provide(layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})

test("stale read snapshots fail promptly rather than retrying a transaction fragment", async () => {
  await using dir = await tmpdir()
  const filename = `${dir.path}/snapshot.db`
  const owner = new Database(filename)
  owner.run("PRAGMA journal_mode = WAL")
  owner.run("CREATE TABLE writes (id INTEGER PRIMARY KEY)")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* SqlClient
        yield* client.unsafe("BEGIN")
        yield* client.unsafe("SELECT * FROM writes")
        owner.run("INSERT INTO writes VALUES (1)")
        const start = performance.now()
        const result = yield* client.unsafe("INSERT INTO writes VALUES (2)").pipe(Effect.flip)
        expect(result.message).toContain("errno=517")
        expect(performance.now() - start).toBeLessThan(1000)
        yield* client.unsafe("ROLLBACK")
        expect(owner.query("SELECT count(*) AS n FROM writes").get()).toEqual({ n: 1 })
      }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
    )
  } finally {
    owner.close()
  }
})
