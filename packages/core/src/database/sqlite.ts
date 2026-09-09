export * as Sqlite from "./sqlite"

import { Context, Effect, Schedule } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { drizzle } from "drizzle-orm/bun-sqlite"

export type DrizzleClient = ReturnType<typeof drizzle>
export class Native extends Context.Service<Native, unknown>()("@opencode-ai/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@opencode-ai/core/database/SqliteDrizzle") {}

export function executeErrorMessage(cause: unknown) {
  if (!cause || typeof cause !== "object") return "Failed to execute statement"
  const code =
    "code" in cause && typeof cause.code === "string" && /^SQLITE_[A-Z_]+$/.test(cause.code) ? cause.code : undefined
  const errno = "errno" in cause && typeof cause.errno === "number" ? cause.errno : undefined
  // Do not include native messages: constraint errors can contain user data.
  return `Failed to execute statement${code ? ` (${code}${errno !== undefined ? `, errno=${errno}` : ""})` : ""}`
}

export function retryBusy<A, R>(effect: Effect.Effect<A, SqlError, R>, canRetry: () => boolean) {
  return Effect.suspend(() => {
    const eligible = canRetry()
    const deadline = Date.now() + 30_000
    return effect.pipe(
      Effect.retry({
        while: (error) => {
          const cause = error.reason.cause
          // Retry only ordinary SQLITE_BUSY outside a transaction. A stale read
          // snapshot needs a transaction restart; replaying its last write is unsafe.
          return (
            eligible &&
            canRetry() &&
            Date.now() < deadline &&
            !!cause &&
            typeof cause === "object" &&
            "errno" in cause &&
            cause.errno === 5
          )
        },
        schedule: Schedule.spaced("25 millis"),
      }),
    )
  })
}
