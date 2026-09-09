import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../../src/database/sqlite.bun"

const filename = process.argv[2]!
const worker = Number(process.argv[3])
await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* SqlClient
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    for (let i = 0; i < 100; i++) {
      yield* db.transaction(
        () =>
          Effect.gen(function* () {
            const rows = yield* client.unsafe("SELECT n FROM counter").values
            yield* client.unsafe("UPDATE counter SET n = ?", [Number(rows[0]![0]) + 1])
            yield* client.unsafe("INSERT INTO writes VALUES (?)", [worker * 100 + i])
            // Match asynchronous event projection while holding the writer lock.
            yield* Effect.sleep("1 millis")
          }),
        { behavior: "immediate" },
      )
    }
  }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
)
