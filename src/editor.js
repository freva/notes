// Milkdown editor wrapper.
//
// CrepeBuilder already gives us the commonmark *and* gfm presets, undo history,
// clipboard handling and the markdown change listener — so tables, task lists,
// strikethrough and autolinks parse and serialize out of the box, and tables
// come with the `|3x2|` input rule, Tab/Shift-Tab cell navigation and
// Mod-Enter to break out.
//
// No crepe features are registered — not `table`, which only adds floating
// drag handles and add-row/column buttons on hover, and not `list-item`, whose
// node view corrupts fast typing (see task-checkbox.js). What we add instead is
// three small local plugins: input rules for `[]`/`[x]` and `[text](url)`, and
// a click handler for the checkboxes.
//
// To switch a crepe feature on, import it from '@milkdown/crepe/feature/<name>',
// call crepe.addFeature() with it, and pull in its stylesheet the same way:
//
//   import { table } from '@milkdown/crepe/feature/table'
//   import '@milkdown/crepe/theme/common/table.css'

import { CrepeBuilder } from '@milkdown/crepe/builder'
import { editorViewCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark'
import { wrapInTaskListInputRule } from '@milkdown/kit/preset/gfm'

import { linkInputRule, taskListInputRule } from './input-rules.js'
import { taskCheckboxClick } from './task-checkbox.js'

let instance = null
let onChange = null

// Bumped on every load/unload so a slow create() belonging to a note the user
// has already navigated away from can detect that it lost the race and bail.
let generation = 0

export function configure(options) {
  onChange = options.onChange ?? null
}

async function createInstance(root, markdown) {
  const crepe = new CrepeBuilder({ root, defaultValue: markdown })

  // Without this, an empty paragraph is serialized as a literal `<br />` so it
  // survives a round trip. We would rather the .md files stay clean markdown —
  // and the server derives a note's filename from its first line, which that
  // `<br />` would otherwise hijack. Blank lines are dropped on reload instead.
  // Awaited, because removing plugins once create() is in flight only warns.
  await crepe.editor.remove(remarkPreserveEmptyLinePlugin)

  // See input-rules.js: ours accepts `[]` and works outside a list, so gfm's
  // narrower rule has to go or both would match `[ ] ` and `[x] `.
  await crepe.editor.remove(wrapInTaskListInputRule)
  crepe.editor
    .use(taskListInputRule)
    .use(linkInputRule)
    .use(taskCheckboxClick)

  // Every save re-serializes the whole note, so match the markers people
  // normally write by hand — otherwise remark's defaults turn every `- item`
  // into `* item` and every `---` into `***` the first time a note is touched.
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (options) => ({
      ...options,
      bullet: '-',
      rule: '-',
    }))
  })

  crepe.on((listener) => {
    listener.markdownUpdated(() => {
      // Ignore updates from an instance that is no longer the live one.
      if (instance === crepe && onChange) onChange()
    })
  })

  return crepe
}

async function teardown() {
  if (!instance) return
  const old = instance
  instance = null
  await old.destroy()
}

/// Replace the editor with a fresh instance holding `markdown`. Recreating
/// rather than swapping the doc keeps the undo history scoped to one note.
/// Returns the markdown as Milkdown serializes it — which is what subsequent
/// `getMarkdown()` calls are compared against — or null if superseded.
export async function load(root, markdown) {
  const gen = ++generation
  await teardown()
  if (gen !== generation) return null

  root.innerHTML = ''
  const crepe = await createInstance(root, markdown)
  await crepe.create()

  if (gen !== generation) {
    await crepe.destroy()
    return null
  }

  instance = crepe
  return crepe.getMarkdown()
}

export async function unload(root) {
  generation++
  await teardown()
  if (root) root.innerHTML = ''
}

export function getMarkdown() {
  return instance ? instance.getMarkdown() : ''
}

export function isLoaded() {
  return instance !== null
}

export function focus() {
  if (!instance) return
  instance.editor.action((ctx) => {
    ctx.get(editorViewCtx).focus()
  })
}
