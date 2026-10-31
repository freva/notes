// Formatting commands and the keymap that reaches them.
//
// The note is markdown source, so every command is a text edit: Mod-B wraps
// the selection in `**`, Mod-Alt-2 rewrites a line's prefix to `## `, and so
// on. Inline toggles look at the syntax tree first, so Mod-B inside bold text
// unwraps it rather than nesting another pair of markers.
//
//   Mod-B          bold                 Mod-Alt-0       plain paragraph
//   Mod-I          italic               Mod-Alt-1…6     heading 1 to 6
//   Mod-E          inline code          Mod-Alt-7       numbered list
//   Mod-Shift-X    strikethrough        Mod-Alt-8       bullet list
//   Mod-Alt-X      strikethrough        Mod-Shift-B     block quote
//   Mod-K          link (link-prompt.js) Mod-Alt-C      code block
//   Tab/Shift-Tab  indent/outdent

import { indentLess, indentMore } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

import { openLinkPrompt } from './link-prompt.js'

// ---------------- Inline ----------------

/// The innermost `name` node that covers [from, to], if any.
function enclosing(state, name, from, to) {
  for (let node = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (node.name === name && node.from <= from && node.to >= to) return node
  }
  for (let node = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) {
    if (node.name === name && node.from <= from && node.to >= to) return node
  }
  return null
}

/// Toggles `marker` around each selection range. Inside an existing `node`
/// of that kind the markers come off; otherwise they go on, and an empty
/// selection gets an empty pair with the cursor between.
function toggleInline(marker, nodeName, markName) {
  return (view) => {
    const { state } = view
    const tr = state.changeByRange((range) => {
      const node = enclosing(state, nodeName, range.from, range.to)
      if (node) {
        const marks = node.getChildren(markName)
        const open = marks[0]
        const close = marks.at(-1)
        if (open && close && open !== close) {
          const changes = state.changes([
            { from: open.from, to: open.to },
            { from: close.from, to: close.to },
          ])
          return { changes, range: range.map(changes) }
        }
      }

      // Already wrapped from the outside, `**|text|**`: unwrap.
      const before = state.sliceDoc(range.from - marker.length, range.from)
      const after = state.sliceDoc(range.to, range.to + marker.length)
      if (!range.empty && before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - marker.length, to: range.from },
            { from: range.to, to: range.to + marker.length },
          ],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        }
      }

      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      }
    })
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

const toggleBold = toggleInline('**', 'StrongEmphasis', 'EmphasisMark')
const toggleItalic = toggleInline('*', 'Emphasis', 'EmphasisMark')
const toggleCode = toggleInline('`', 'InlineCode', 'CodeMark')
const toggleStrike = toggleInline('~~', 'Strikethrough', 'StrikethroughMark')

// ---------------- Line prefixes ----------------

const HEADING = /^#{1,6}[ \t]+|^#{1,6}$/
const QUOTE = /^>[ \t]?/
const BULLET = /^[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/
const ORDERED = /^\d{1,9}[.)][ \t]+/
const LIST = new RegExp(`${BULLET.source}|${ORDERED.source}`)

/// Each line touched by the selection, once, in document order.
function selectedLines(state) {
  const seen = new Set()
  const lines = []
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      lines.push(state.doc.line(n))
    }
  }
  return lines.sort((a, b) => a.from - b.from)
}

/// What a line prefix goes after: indentation and, except for the quote toggle
/// itself, any `>` the line sits in, so a heading in a quote is `> ## Title`.
const INDENT = /^[ \t]*/
const INDENT_AND_QUOTES = /^[ \t]*(?:>[ \t]?)*/

/// Rewrites the prefix of every selected line: `strip` matches what comes off
/// (after `lead`), `make(index)` is what goes on.
function rewritePrefixes(view, strip, make, { skipBlank = true, lead = INDENT_AND_QUOTES } = {}) {
  const { state } = view
  const all = selectedLines(state)
  // Blank lines between the paragraphs of a selection are not list items or
  // headings; a single blank line is, since that is how you start one.
  const lines = skipBlank && all.length > 1 ? all.filter((line) => line.text.trim() !== '') : all
  const changes = []
  lines.forEach((line, index) => {
    const indent = lead.exec(line.text)[0]
    const rest = line.text.slice(indent.length)
    const existing = strip.exec(rest)?.[0] ?? ''
    const insert = make(index)
    const from = line.from + indent.length
    if (existing !== insert) changes.push({ from, to: from + existing.length, insert })
  })
  if (changes.length) {
    view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' })
  }
  return true
}

/// Whether every non-blank selected line already starts with `pattern`.
function allMatch(state, pattern, lead = INDENT_AND_QUOTES) {
  const lines = selectedLines(state).filter((line) => line.text.trim() !== '')
  return (
    lines.length > 0 &&
    lines.every((line) => pattern.test(line.text.slice(lead.exec(line.text)[0].length)))
  )
}

const setHeading = (level) => (view) =>
  rewritePrefixes(view, HEADING, () => (level ? `${'#'.repeat(level)} ` : ''))

function toggleBulletList(view) {
  const on = allMatch(view.state, /^[-*+][ \t]/)
  return rewritePrefixes(view, LIST, () => (on ? '' : '- '))
}

function toggleOrderedList(view) {
  const on = allMatch(view.state, ORDERED)
  return rewritePrefixes(view, LIST, (index) => (on ? '' : `${index + 1}. `))
}

function toggleQuote(view) {
  const on = allMatch(view.state, QUOTE, INDENT)
  return rewritePrefixes(view, QUOTE, () => (on ? '' : '> '), { skipBlank: false, lead: INDENT })
}

// ---------------- Code block ----------------

/// Mod-Alt-C: fences the selected lines, or takes the fences off the block the
/// cursor is in. On an empty line it opens an empty block.
function toggleCodeBlock(view) {
  const { state } = view
  const { main } = state.selection

  let fence = syntaxTree(state).resolveInner(main.head, -1)
  while (fence && fence.name !== 'FencedCode') fence = fence.parent
  if (fence) {
    const first = state.doc.lineAt(fence.from)
    const last = state.doc.lineAt(fence.to)
    const closed = fence.getChildren('CodeMark').length > 1 && last.number > first.number
    const changes = [{ from: first.from, to: Math.min(first.to + 1, state.doc.length) }]
    if (closed) changes.push({ from: Math.max(last.from - 1, first.to), to: last.to })
    view.dispatch({ changes, userEvent: 'input.format' })
    return true
  }

  const firstLine = state.doc.lineAt(main.from)
  const lastLine = state.doc.lineAt(main.to)
  if (main.empty && firstLine.text.trim() === '') {
    view.dispatch({
      changes: { from: firstLine.from, to: firstLine.to, insert: '```\n\n```' },
      selection: { anchor: firstLine.from + 4 },
      userEvent: 'input.format',
    })
    return true
  }
  view.dispatch({
    changes: [
      { from: firstLine.from, insert: '```\n' },
      { from: lastLine.to, insert: '\n```' },
    ],
    userEvent: 'input.format',
  })
  return true
}

// ---------------- Lists ----------------

/// Tab and Shift-Tab indent and outdent. In a list that nests or un-nests the
/// item; elsewhere it shifts the line, which is how you start a nested list.
function inList(state) {
  return selectedLines(state).some((line) => LIST.test(line.text.trimStart()))
}

const indentList = (view) => (inList(view.state) ? indentMore(view) : false)
const outdentList = (view) => indentLess(view)

// ---------------- Task shortcut ----------------

/// `[] `, `[ ] ` or `[x] ` at the start of a line makes it a task, wrapping it
/// in a bullet on the way; `- [] ` gets the space it needs to parse. Typing
/// `- [ ] ` in full needs no help, it already is one.
const TASK_START = /^([ \t]*)(?:([-*+]|\d{1,9}[.)]) )?\[([ xX]?)\]$/

export const taskShortcut = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to) return false
  const { state } = view
  const line = state.doc.lineAt(from)
  const match = TASK_START.exec(state.sliceDoc(line.from, from))
  if (!match) return false
  const [, indent, bullet, mark] = match
  if (bullet && mark !== '') return false
  for (let node = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
      return false
    }
  }
  const insert = `${indent}${bullet ?? '-'} [${mark === '' ? ' ' : mark.toLowerCase()}] `
  view.dispatch({
    changes: { from: line.from, to, insert },
    selection: { anchor: line.from + insert.length },
    userEvent: 'input.type',
  })
  return true
})

// ---------------- Keymap ----------------

export const formattingKeymap = keymap.of([
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-e', run: toggleCode },
  { key: 'Mod-Shift-x', run: toggleStrike },
  { key: 'Mod-Alt-x', run: toggleStrike },
  { key: 'Mod-k', run: openLinkPrompt },
  { key: 'Mod-Alt-0', run: setHeading(0) },
  { key: 'Mod-Alt-1', run: setHeading(1) },
  { key: 'Mod-Alt-2', run: setHeading(2) },
  { key: 'Mod-Alt-3', run: setHeading(3) },
  { key: 'Mod-Alt-4', run: setHeading(4) },
  { key: 'Mod-Alt-5', run: setHeading(5) },
  { key: 'Mod-Alt-6', run: setHeading(6) },
  { key: 'Mod-Alt-7', run: toggleOrderedList },
  { key: 'Mod-Alt-8', run: toggleBulletList },
  { key: 'Mod-Shift-b', run: toggleQuote },
  { key: 'Mod-Alt-c', run: toggleCodeBlock },
  { key: 'Tab', run: indentList },
  { key: 'Shift-Tab', run: outdentList },
])
