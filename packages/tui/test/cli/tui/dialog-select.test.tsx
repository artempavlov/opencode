/** @jsxImportSource @opentui/solid */
import { InputRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { DialogSelect, type DialogSelectRef } from "../../../src/ui/dialog-select"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)])
}

test("large model catalogs keep bounded rows through selection, filtering and regrouping", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const [options, setOptions] = createSignal(
    Array.from({ length: 20000 }, (_, value) => ({
      value,
      title: `Model-${String(value).padStart(5, "0")}`,
      category: `Provider-${Math.floor(value / 5000)}`,
    })),
  )
  const selected: number[] = []
  let ref: DialogSelectRef<number> | undefined
  let keymap: ReturnType<typeof createDefaultOpenTuiKeymap> | undefined

  function Picker() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSelect
          title="Models"
          options={options()}
          virtual
          flat
          ref={(value) => (ref = value)}
          onSelect={(option) => selected.push(option.value)}
        />
      )),
    )
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Picker />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 40 })
  async function frame() {
    await Bun.sleep(20)
    await app.renderOnce()
    await app.renderOnce()
    expect(descendants(app.renderer.root).length).toBeLessThan(500)
    return app.captureCharFrame()
  }
  try {
    for (let attempt = 0; attempt < 100 && !app.renderer.currentFocusedRenderable; attempt++) {
      await Bun.sleep(20)
      await app.renderOnce()
    }
    expect(await frame()).toContain("Model-00000")
    expect(ref?.filtered).toHaveLength(20000)
    ref?.moveTo(19999)
    expect(await frame()).toContain("Model-19999")
    keymap?.dispatchCommand("dialog.select.submit")
    expect(selected).toEqual([19999])

    // New object identities and category order must not mount a second full catalog.
    setOptions(
      options()
        .map((option) => ({ ...option, category: "Recent" }))
        .reverse(),
    )
    await frame()
    ref?.moveTo(15000)
    expect(await frame()).toContain("Model-15000")
    keymap?.dispatchCommand("dialog.select.submit")
    expect(selected).toEqual([19999, 15000])

    const scroll = descendants(app.renderer.root).find((node) => node instanceof ScrollBoxRenderable)
    if (!(scroll instanceof ScrollBoxRenderable)) throw new Error("missing scrollbox")
    scroll.scrollTo(10000)
    expect(await frame()).toContain("Model-10000")

    expect(app.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable)
    for (const char of "Model-19999") app.mockInput.pressKey(char)
    expect(await frame()).toContain("Model-19999")
    expect(ref?.filtered).toHaveLength(1)
    app.mockInput.pressEnter()
    expect(selected).toEqual([19999, 15000, 19999])
    app.mockInput.pressKey("u", { ctrl: true })
    await frame()
    expect(ref?.filtered).toHaveLength(20000)
    ref?.moveTo(0)
    expect(await frame()).toContain("Model-00000")
  } finally {
    app.renderer.destroy()
  }
})
