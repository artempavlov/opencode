# Local SQLite contention fix

Base: upstream OpenCode v1.18.29 (`16747470f976aca3d362ad730bcd3fe82ecc2c9a`).
Local binary version: `1.18.29-sqlite-fix.1`. Verified on 2026-09-09.

## Finding and limits

The Bun SQLite driver returned `Failed to execute statement` after a synchronous
busy wait expired. Independent OpenCode processes share the same SQLite database.
A competing writer can therefore fail even though the database is healthy.

The isolated driver test reproduced that exact error with native `SQLITE_BUSY`,
errno 5. The original installed binary failed all eight competing inserts while
another connection held a writer lock for eight seconds. The patched binary
passed the same test with all eight rows present.

Historical production logs omit the native code, so this evidence does not prove
that every historical failure had this cause. In particular, stale snapshots and
foreign-key errors are different failures and are not repaired by retrying writes.

## Implementation

- Before acquiring a transaction, or in autocommit mode, use 50 ms native waits
  and yield for 25 ms between ordinary `SQLITE_BUSY` retries, with a 30 s budget.
- Retry only if the connection was outside a transaction before the operation
  and remains outside it after the failure. This covers `BEGIN IMMEDIATE` used
  by durable events without replaying their projectors or tools.
- Keep the previous 5 s native wait inside transactions. Do not retry transaction
  fragments, constraints, or `SQLITE_BUSY_SNAPSHOT` (517).
- Include SQLite code/errno in the driver error without copying native messages,
  SQL, or parameters. Drizzle wrappers can still hide this detail in CLI output.
- Apply the same bounded wait to initial WAL setup. The Node driver retains its
  previous default 5 s timeout; asynchronous retry is implemented for Bun.

No schema or production database changes are part of this patch.

## Verification

Use Bun 1.3.14 (the upstream package-manager requirement). Nixpkgs on this host
provided 1.3.13, so the build used `npm exec --yes --package=bun@1.3.14 -- bun`.

From `packages/core`:

```sh
bun typecheck
OPENCODE_TEST_BINARY="$PWD/../opencode/dist/opencode-linux-x64/bin/opencode" \
  bun test test/database-binary-concurrency.test.ts test/database-concurrency.test.ts \
  test/database-migration.test.ts test/event.test.ts
```

Result: 69 tests passed, 133 assertions. Tests create temporary databases and
isolate CLI XDG paths. Coverage includes eight writer processes committing 800
transactions with exact row/counter checks, short and six-second lock waits,
constraint propagation, prompt snapshot failure, migrations, and durable events.
`bun typecheck` also passed in `packages/opencode`.

To demonstrate the original regression, set `OPENCODE_TEST_BINARY` to the original
v1.18.29 executable and run only `test/database-binary-concurrency.test.ts`.

## Build and packaging

From the repository root, install dependencies with
`bun install --frozen-lockfile --ignore-scripts`. From `packages/opencode`:

```sh
OPENCODE_VERSION=1.18.29-sqlite-fix.1 OPENCODE_CHANNEL=latest \
  bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

The `latest` channel is deliberate: it keeps the existing database path. The
build uses the upstream models.dev snapshot and does not embed the browser UI.
The resulting standalone binary is `dist/opencode-linux-x64/bin/opencode`.

For local npm packaging, change the generated platform package's `name` to
`opencode-ai`, add `"bin": {"opencode": "bin/opencode"}`, then run `npm pack`
from that directory. Keep the tarball under the ignored `local-release/` in the
persistent checkout at `/home/artem/data/projects_active/opencode-sqlite-fix`.
Install the tarball using `npm install --global /absolute/path/to/tarball`.

Global `~/.config/opencode/opencode.jsonc` has `autoupdate: false` so upstream
updates cannot replace this local fix. Restart each OpenCode process to load the
new binary. Existing processes retain their old executable and configuration.

## Return to upstream

`npm install --global opencode-ai@1.18.29` restores the original version, or install
a newer version after confirming it contains an equivalent fix. Remove the local
`autoupdate: false` setting if automatic updates are wanted again. Restart OpenCode.
These package/config changes do not require deleting, migrating, or copying the
production database.

## References

- <https://www.sqlite.org/isolation.html>
- <https://github.com/anomalyco/opencode/issues/44859>
- <https://github.com/anomalyco/opencode/pull/36570> (closed, not merged)
