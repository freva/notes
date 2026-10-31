// Mod-K: a one-field prompt for turning the selection into a link.
//
// The prompt is one absolutely positioned element inside the editor (see
// `.link-prompt` in style.css; .cm-editor is the positioning parent). Its
// input is outside .cm-content, so CodeMirror never sees the typing in it; the
// target range lives in a state field instead, where a decoration keeps it
// highlighted while the editor is unfocused.
//
// On apply the source is rewritten: `text` becomes `[text](url)`, an existing
// link gets its URL replaced, and an emptied field unlinks it.

import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const WORD_CHAR = /[\p{L}\p{N}_'-]/u
const UNSAFE_SCHEME = /^(javascript|vbscript|data):/i

/// What people type is rarely a URL: `example.com` and `me@example.com` are
/// both meant as links. Guess the scheme; '' for a scheme that runs code.
function normalizeHref(raw) {
  let value = raw.replace(/\s/g, '%20')
  if (!HAS_SCHEME.test(value) && !value.startsWith('/') && !value.startsWith('#')) {
    value = LOOKS_LIKE_EMAIL.test(value) ? `mailto:${value}` : `https://${value}`
  }
  if (UNSAFE_SCHEME.test(value)) return ''
  // A `)` would end the destination early; the angle-bracket form takes it.
  return /[()<>]/.test(value) ? `<${value.replace(/[<>]/g, encodeURIComponent)}>` : value
}

const setPrompt = StateEffect.define()

const promptField = StateField.define({
  create: () => null,
  update(open, tr) {
    for (const effect of tr.effects) if (effect.is(setPrompt)) return effect.value
    if (!open || !tr.docChanged) return open
    const from = tr.changes.mapPos(open.from, 1)
    const to = tr.changes.mapPos(open.to, -1)
    return to < from ? null : { ...open, from, to }
  },
  provide: (field) =>
    EditorView.decorations.from(field, (open) =>
      open && open.to > open.from
        ? Decoration.set([Decoration.mark({ class: 'link-prompt-target' }).range(open.from, open.to)])
        : Decoration.none
    ),
})

/// The Link node around [from, to], if the range sits in one.
function linkAround(state, from, to) {
  for (let node = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (node.name === 'Link' && node.from <= from && node.to >= to) return node
  }
  return null
}

/// The word the cursor sits in, so Mod-K works without selecting first.
function wordRangeAt(state, pos) {
  const line = state.doc.lineAt(pos)
  let start = pos - line.from
  let end = start
  while (start > 0 && WORD_CHAR.test(line.text[start - 1])) start--
  while (end < line.text.length && WORD_CHAR.test(line.text[end])) end++
  if (start === end) return null
  return { from: line.from + start, to: line.from + end }
}

/// What Mod-K will link, and the href to prefill the input with. An empty
/// range is a valid answer: the URL then becomes its own link text.
function target(state) {
  const { from, to, empty } = state.selection.main
  const link = linkAround(state, from, to)
  if (link) {
    const url = link.getChild('URL')
    const [open, close] = link.getChildren('LinkMark')
    return {
      from: link.from,
      to: link.to,
      href: url ? state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '') : '',
      text: close ? state.sliceDoc(open.to, close.from) : '',
      link: true,
    }
  }
  if (!empty) return { from, to, href: '', text: state.sliceDoc(from, to), link: false }
  const word = wordRangeAt(state, from) ?? { from, to }
  return { ...word, href: '', text: state.sliceDoc(word.from, word.to), link: false }
}

export function openLinkPrompt(view) {
  view.dispatch({ effects: setPrompt.of(target(view.state)) })
  return true
}

class LinkPromptView {
  constructor(view) {
    this.view = view
    this.open = null
    this.destroyed = false

    this.input = document.createElement('input')
    this.input.type = 'text'
    this.input.placeholder = 'Paste or type a link, then Enter'
    this.input.spellcheck = false

    this.dom = document.createElement('div')
    this.dom.className = 'link-prompt'
    this.dom.hidden = true
    this.dom.appendChild(this.input)
    view.dom.appendChild(this.dom)

    this.input.addEventListener('keydown', (event) => {
      // Keep the typing from any document-level shortcut handler.
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        this.apply()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.close(true)
      }
    })
    this.input.addEventListener('input', () => this.input.classList.remove('invalid'))
    // Clicking away cancels, without stealing focus back from wherever the
    // click landed.
    this.input.addEventListener('blur', () => this.close(false))
  }

  update(update) {
    const open = update.state.field(promptField)
    const wasOpen = this.open
    this.open = open

    if (!open) {
      this.dom.hidden = true
      return
    }
    if (!wasOpen) {
      this.dom.hidden = false
      this.input.value = open.href
      this.input.classList.remove('invalid')
      // Focusing from inside an update would re-enter the view.
      queueMicrotask(() => {
        this.input.focus()
        this.input.select()
      })
    }
    this.view.requestMeasure({
      read: (view) => ({
        anchor: view.coordsAtPos(open.from, 1),
        box: view.dom.getBoundingClientRect(),
      }),
      write: ({ anchor, box }) => {
        if (!anchor) return
        const limit = Math.max(0, box.width - this.dom.offsetWidth - 8)
        this.dom.style.left = `${Math.min(Math.max(0, anchor.left - box.left), limit)}px`
        this.dom.style.top = `${anchor.bottom - box.top + 6}px`
      },
    })
  }

  apply() {
    const open = this.open
    if (!open) return
    const raw = this.input.value.trim()
    const { from, to, text } = open
    let insert

    if (!raw) {
      // Emptying the field on an existing link is how you unlink it.
      if (!open.link) return this.close(true)
      insert = text
    } else {
      const href = normalizeHref(raw)
      if (!href) {
        this.input.classList.add('invalid')
        return
      }
      insert = `[${text || raw}](${href})`
    }

    this.view.dispatch({
      changes: { from, to, insert },
      effects: setPrompt.of(null),
      // The caret goes past the link, so whatever is typed next is plain text.
      selection: { anchor: from + insert.length },
      userEvent: 'input.format',
    })
    this.view.focus()
  }

  close(restoreFocus) {
    // Switching notes destroys the editor under an open prompt, and pulling
    // the input out of the document blurs it — by then there is no view.
    if (this.destroyed || !this.view.state.field(promptField)) return
    this.view.dispatch({ effects: setPrompt.of(null) })
    if (restoreFocus) this.view.focus()
  }

  destroy() {
    this.destroyed = true
    this.dom.remove()
  }
}

export const linkPrompt = [promptField, ViewPlugin.fromClass(LinkPromptView)]
