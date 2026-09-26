# Local fixes on OpenCode v1.18.32

Branch: `fixes-1.18.32` in https://github.com/artempavlov/opencode.
Upstream base: `545f51d26cc39a907d2867492d498d9607ea5fa4` (`v1.18.32`).
Combined binary version: `1.18.32-local-fixes.1`.

## Included fixes

- `b13f242`: Bun SQLite contention retry, ported from `83c58a70d`.
  Short native waits yield between retries outside transactions. Constraints
  and stale transaction snapshots are not retried. See `SQLITE-CONCURRENCY-FIX.md`.
- `a0162de`: virtualized model picker, ported from `a4360e7`.
  Large catalogs no longer mount all rows or exhaust native TextBuffer handles
  when selecting or searching. Full search/navigation and configured plugins remain available.

Neither fix changes the database schema or provider credentials.
Preserve both commits when integrating a later upstream version.

## Build

Use Bun 1.3.14. On a host with a different Bun version, prefix commands with
`npm exec --yes --package=bun@1.3.14 --`.

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
```

From `packages/opencode`:

```sh
OPENCODE_VERSION=1.18.32-local-fixes.1 OPENCODE_CHANNEL=latest bun run script/build.ts --single --skip-install
```

This includes the web UI. Keep channel `latest` to preserve the normal data paths.
Output: `packages/opencode/dist/opencode-linux-x64/bin/opencode`.

## Verify

Run `bun typecheck` separately in `packages/core`, `packages/tui`, and `packages/opencode`.
Run tests from their package directories, never from the repository root.

From `packages/core`:

```sh
OPENCODE_TEST_BINARY="$PWD/../opencode/dist/opencode-linux-x64/bin/opencode" \
  bun test test/database-binary-concurrency.test.ts test/database-concurrency.test.ts \
  test/database-migration.test.ts test/event.test.ts
```

The database tests use disposable databases and isolated CLI paths.
Never run contention tests against a production database.

From `packages/tui`:

```sh
bun test
```

Results on 2026-09-26:

- All three package typechecks passed.
- SQLite: 69 tests passed, 133 assertions. Includes 8 concurrent CLI processes
  waiting out an 8-second writer lock, 800 committed transactions, constraints,
  stale snapshots, migrations, and events.
- TUI final full run: 195 passed, 1 skipped, 0 failed, 8 snapshots.
  Earlier full runs intermittently failed existing DiffViewerFileTree frame
  assertions; the focused run and final full run passed without modifying those tests.
- The 20,000-model regression checks bounded rendering, navigation, regrouping,
  scrolling, filtering, selection, and clearing the filter.
- A PTY smoke test with the real configuration and all plugins passed initial
  selection and four further model selections, including search and variants.
  No LLM prompt was submitted. Selection can update recent-model/variant state.
- The installed global binary matches the tested build byte-for-byte (SHA-256
  `868c38dc7717522676f2c2c5ad655c8708d0a7fabe9b4148ab7e1d4873b84822`).
  The 8-process SQLite lock test was also rerun against the installed command:
  1 passed, 6 assertions.

## Install and rollback

For a local Linux x64 npm package, set the generated platform package's name to
`opencode-ai`, add `"bin": {"opencode": "./bin/opencode"}`, and mark it private.
Run `npm pack --pack-destination <repo>/local-release` from that package directory.
The ignored `local-release/` directory holds the installation artifact.

```sh
npm install -g --ignore-scripts ./local-release/opencode-ai-1.18.32-local-fixes.1.tgz
opencode --version
```

Restart existing processes after installation. They retain their old executable.
The local configuration already disables automatic updates; upgrading from npm
or the upstream updater replaces this combined binary and can remove both fixes.

Rollback to upstream, only if needed:

```sh
npm install -g opencode-ai@1.18.32
```

Rollback removes both local fixes. It does not require deleting or migrating user data.
