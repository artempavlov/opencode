import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { tmpdir } from "./fixture/tmpdir"

const binary = process.env.OPENCODE_TEST_BINARY

test.skipIf(!binary)(
  "compiled CLI: eight processes survive an eight-second writer lock",
  async () => {
    await using dir = await tmpdir()
    const filename = `${dir.path}/binary.db`
    const env = {
      ...process.env,
      OPENCODE_DB: filename,
      OPENCODE_TEST_HOME: dir.path,
      XDG_DATA_HOME: `${dir.path}/data`,
      XDG_CONFIG_HOME: `${dir.path}/config`,
      XDG_CACHE_HOME: `${dir.path}/cache`,
      XDG_STATE_HOME: `${dir.path}/state`,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_PURE: "1",
    }
    const run = (query: string) =>
      Bun.spawn([binary!, "db", query, "--format", "json"], {
        cwd: dir.path,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
    const result = async (child: ReturnType<typeof run>) => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { code, stdout, stderr }
    }
    expect((await result(run("CREATE TABLE writes (id INTEGER PRIMARY KEY)"))).code).toBe(0)
    const owner = new Database(filename)
    owner.run("BEGIN IMMEDIATE")
    const release = setTimeout(() => owner.run("COMMIT"), 8000)
    const workers = Array.from({ length: 8 }, (_, i) => run(`INSERT INTO writes VALUES (${i})`))
    try {
      const results = await Promise.all(workers.map(result))
      expect(results.filter((item) => item.code !== 0)).toEqual([])
      expect(owner.query("SELECT count(*) AS n FROM writes").get()).toEqual({ n: 8 })
      expect(owner.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      const constraint = await result(run("INSERT INTO writes VALUES (0)"))
      expect(constraint.code).not.toBe(0)
      expect(constraint.stderr).toContain("Failed query")
    } finally {
      clearTimeout(release)
      if (owner.inTransaction) owner.run("ROLLBACK")
      workers.forEach((worker) => worker.kill())
      await Promise.all(workers.map((worker) => worker.exited))
      owner.close()
    }
  },
  30_000,
)
