// Mod-K: a one-field prompt for turning the selection into a link.
//
// Crepe ships a link-tooltip feature that can do this, but it pulls in the
// lit-based @milkdown/kit/component bundle for a popover, has no keyboard
// entry point, and duplicates the click-to-open handling app.js already does.
// This is the same idea in a plain <input>.
//
// The prompt is one absolutely positioned element parked next to the editor
// (see `.link-prompt` in style.css — `.milkdown` is the positioning parent).
// Because it lives outside view.dom, ProseMirror never sees the typing in it;
// the target range instead lives in plugin state, where a decoration keeps it
// highlighted while the editor is unfocused.

import { linkSchema, sanitizeLinkHref } from '@milkdown/kit/preset/commonmark'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $command, $prose } from '@milkdown/kit/utils'

const linkPromptKey = new PluginKey('notesLinkPrompt')

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const WORD_CHAR = /[\p{L}\p{N}_'-]/u

/// What people type is rarely a URL: `example.com` and `me@example.com` are
/// both meant as links. Guess the scheme, then let commonmark's own sanitizer
/// have the last word — it returns '' for `javascript:` and friends.
function normalizeHref(raw) {
  let value = raw
  if (!HAS_SCHEME.test(value) && !value.startsWith('/') && !value.startsWith('#')) {
    value = LOOKS_LIKE_EMAIL.test(value) ? `mailto:${value}` : `https://${value}`
  }
  return sanitizeLinkHref(value)
}

/// The full span of the `type` mark under `$pos`, or null if there is none.
/// Adjacent marks only merge when they are `eq`, so two different links that
/// happen to touch stay two ranges.
function markRangeAt($pos, type) {
  const { parent, parentOffset } = $pos

  let found = parent.childAfter(parentOffset)
  if (!found.node || !type.isInSet(found.node.marks)) found = parent.childBefore(parentOffset)
  const mark = found.node && type.isInSet(found.node.marks)
  if (!mark) return null

  let index = found.index
  let from = $pos.start() + found.offset
  while (index > 0 && mark.isInSet(parent.child(index - 1).marks)) {
    index--
    from -= parent.child(index).nodeSize
  }

  let to = from
  while (index < parent.childCount && mark.isInSet(parent.child(index).marks)) {
    to += parent.child(index).nodeSize
    index++
  }

  return { from, to, href: mark.attrs.href }
}

/// The word the cursor sits in, so Mod-K works without selecting first.
function wordRangeAt($pos) {
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, '￼')
  let start = $pos.parentOffset
  let end = $pos.parentOffset
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--
  while (end < text.length && WORD_CHAR.test(text[end])) end++
  if (start === end) return null
  return { from: $pos.start() + start, to: $pos.start() + end }
}

/// What Mod-K will link, and the href to prefill the input with. An empty
/// range is a valid answer: the URL then gets inserted as its own link text.
function target(state, linkType) {
  const { $from, from, to, empty } = state.selection
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null

  if (!empty) {
    let href = ''
    state.doc.nodesBetween(from, to, (node) => {
      if (href) return false
      const mark = linkType.isInSet(node.marks)
      if (mark) href = mark.attrs.href
    })
    return { from, to, href }
  }

  return { href: '', ...(markRangeAt($from, linkType) ?? wordRangeAt($from) ?? { from, to }) }
}

export const openLinkPromptCommand = $command('OpenLinkPrompt', (ctx) => () => {
  return (state, dispatch) => {
    const open = target(state, linkSchema.type(ctx))
    if (!open) return false
    if (dispatch) dispatch(state.tr.setMeta(linkPromptKey, open))
    return true
  }
})

class LinkPromptView {
  constructor(ctx, view) {
    this.ctx = ctx
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
    view.dom.parentElement?.appendChild(this.dom)

    this.input.addEventListener('keydown', (event) => {
      // This element is a sibling of view.dom, not a child, so ProseMirror
      // never sees the typing. Stop it here anyway so no document-level
      // shortcut added later starts reacting to it either.
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
    // Clicking away cancels — but without stealing focus back from wherever
    // the click landed.
    this.input.addEventListener('blur', () => this.close(false))
  }

  update(view) {
    const open = linkPromptKey.getState(view.state)
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
      this.input.focus()
      this.input.select()
    }
    this.position(open)
  }

  position(open) {
    const anchor = this.view.coordsAtPos(open.from)
    const parent = this.dom.offsetParent ?? this.dom.parentElement
    if (!parent) return
    const box = parent.getBoundingClientRect()

    const limit = Math.max(0, box.width - this.dom.offsetWidth - 8)
    this.dom.style.left = `${Math.min(Math.max(0, anchor.left - box.left), limit)}px`
    this.dom.style.top = `${anchor.bottom - box.top + 6}px`
  }

  apply() {
    const open = this.open
    if (!open) return

    const raw = this.input.value.trim()
    const linkType = linkSchema.type(this.ctx)
    const { state } = this.view
    const tr = state.tr.setMeta(linkPromptKey, null)

    if (!raw) {
      // Emptying the field on an existing link is how you unlink it.
      if (open.from < open.to) tr.removeMark(open.from, open.to, linkType)
    } else {
      const href = normalizeHref(raw)
      if (!href) {
        this.input.classList.add('invalid')
        return
      }

      let { from, to } = open
      if (from === to) {
        tr.insertText(raw, from)
        to = from + raw.length
      }
      tr.removeMark(from, to, linkType)
        .addMark(from, to, linkType.create({ href, title: null }))
        // Leave the caret past the link with the mark dropped, so whatever is
        // typed next is ordinary text.
        .setSelection(TextSelection.create(tr.doc, to))
        .removeStoredMark(linkType)
    }

    this.view.dispatch(tr)
    this.view.focus()
  }

  close(restoreFocus) {
    // Switching notes destroys the editor under an open prompt, and pulling
    // the input out of the document blurs it — by then there is no view left
    // to dispatch to.
    if (this.destroyed || !linkPromptKey.getState(this.view.state)) return
    this.view.dispatch(this.view.state.tr.setMeta(linkPromptKey, null))
    if (restoreFocus) this.view.focus()
  }

  destroy() {
    this.destroyed = true
    this.dom.remove()
  }
}

const linkPromptPlugin = $prose(
  (ctx) =>
    new Plugin({
      key: linkPromptKey,
      state: {
        init: () => null,
        apply: (tr, open) => {
          const action = tr.getMeta(linkPromptKey)
          if (action !== undefined) return action
          if (!open || !tr.docChanged) return open

          const from = tr.mapping.map(open.from)
          const to = tr.mapping.map(open.to)
          return to < from ? null : { ...open, from, to }
        },
      },
      props: {
        decorations: (state) => {
          const open = linkPromptKey.getState(state)
          if (!open || open.from === open.to) return null
          return DecorationSet.create(state.doc, [
            Decoration.inline(open.from, open.to, { class: 'link-prompt-target' }),
          ])
        },
      },
      view: (view) => new LinkPromptView(ctx, view),
    })
)

export const linkPrompt = [openLinkPromptCommand, linkPromptPlugin].flat()
