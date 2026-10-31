// Markdown editing that reads like the rendered note: one view for writing and
// reading. See ./decorations.js for what shows when.

import { syntaxTree } from '@codemirror/language'
import { Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'

import { buildLivePreview } from './decorations.js'
import { linkTarget } from './links.js'

const setFocused = StateEffect.define()

/// Whether the editor has focus, kept in state so a focus change redraws what
/// the cursor reveals.
const focusedField = StateField.define({
  create: () => false,
  update: (focused, tr) =>
    tr.effects.reduce((value, effect) => (effect.is(setFocused) ? effect.value : value), focused),
})

/// The decorations come from a state field rather than a view plugin: a
/// rendered table replaces whole lines, and only state may hand the editor a
/// block replacement. Each change or cursor move redraws the whole note, which
/// is cheap at note size.
const livePreviewField = StateField.define({
  create: (state) => buildLivePreview(state, state.field(focusedField, false) ?? false),
  update(decorations, tr) {
    const stale =
      tr.docChanged ||
      tr.selection != null ||
      tr.reconfigured ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.startState.field(focusedField) !== tr.state.field(focusedField)
    return stale ? buildLivePreview(tr.state, tr.state.field(focusedField)) : decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

/// Flips the marker of the task whose list mark starts at `pos`, `[ ]` to
/// `[x]` and back, as a user edit so it is saved and undone like typing.
/// `null` when no task starts there.
export function toggleTask(state, pos) {
  let item = syntaxTree(state).resolveInner(pos, 1)
  while (item && item.name !== 'ListItem') item = item.parent
  const marker = item?.getChild('Task')?.getChild('TaskMarker')
  if (!marker) return null
  const at = marker.from + 1
  const done = state.sliceDoc(at, at + 1) !== ' '
  return { changes: { from: at, to: at + 1, insert: done ? ' ' : 'x' }, userEvent: 'input' }
}

/// An opening code fence, with the indentation a closing one must repeat.
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})[^`]*$/

/// Enter at the end of a code fence that nothing closes yet writes the closing
/// fence below and puts the cursor on the empty line between. Markdown runs an
/// unclosed fence to the end of the note, so without this, typing ```js turns
/// everything after it into code until a closing fence is typed by hand.
function closeFenceOnEnter(view) {
  const { state } = view
  const { main } = state.selection
  if (state.selection.ranges.length > 1 || !main.empty) return false
  const line = state.doc.lineAt(main.head)
  const open = main.head === line.to ? FENCE_OPEN.exec(line.text) : null
  if (!open) return false
  let fence = syntaxTree(state).resolveInner(line.to, -1)
  while (fence && fence.name !== 'FencedCode') fence = fence.parent
  if (
    !fence ||
    state.doc.lineAt(fence.from).number !== line.number ||
    fence.getChildren('CodeMark').length > 1
  ) {
    return false
  }
  const [, indent, marks] = open
  view.dispatch({
    changes: { from: line.to, insert: `\n${indent}\n${indent}${marks}` },
    selection: { anchor: line.to + 1 + indent.length },
    userEvent: 'input',
    scrollIntoView: true,
  })
  return true
}

function isTaskBox(target) {
  return target instanceof HTMLInputElement && target.classList.contains('cm-md-task')
}

const clicks = EditorView.domEventHandlers({
  mousedown(event) {
    // A right or middle click keeps its browser meaning.
    if (event.button !== 0) return false
    // The toggle waits for the click (below); held here, the mousedown only
    // keeps the editor from moving the cursor.
    if (isTaskBox(event.target)) {
      event.preventDefault()
      return true
    }
    // A plain click edits the link; Mod-click opens it.
    const href = linkTarget(event.target)
    if (href && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      window.open(href, '_blank', 'noopener,noreferrer')
      return true
    }
    return false
  },
  // The document change redraws the box; the browser's own toggle would draw
  // it a second time.
  click(event, view) {
    if (!isTaskBox(event.target)) return false
    event.preventDefault()
    const spec = toggleTask(view.state, view.posAtDOM(event.target))
    if (spec) view.dispatch(spec)
    return true
  },
})

/// Puts `cm-mod-held` on the editor while Cmd or Ctrl is down, so links show a
/// pointer exactly when a click would open them.
const modHeld = ViewPlugin.define((view) => {
  const sync = (event) => view.dom.classList.toggle('cm-mod-held', event.metaKey || event.ctrlKey)
  const release = () => view.dom.classList.remove('cm-mod-held')
  window.addEventListener('keydown', sync)
  window.addEventListener('keyup', sync)
  window.addEventListener('blur', release)
  return {
    destroy() {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', release)
    },
  }
})

export function livePreview() {
  return [
    focusedField,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    livePreviewField,
    clicks,
    modHeld,
    Prec.high(keymap.of([{ key: 'Enter', run: closeFenceOnEnter }])),
  ]
}
