// The note editor: CodeMirror over the markdown source, drawn as a live
// preview (src/live-preview/). The text in the editor *is* the file — nothing
// is parsed into a document model and serialized back — so a note round-trips
// byte for byte and opening one never rewrites it.
//
// Exposed to public/app.js as the NotesEditor global (see `pnpm run build`).

import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view'
import { tagHighlighter, tags } from '@lezer/highlight'

import { formattingKeymap, taskShortcut } from './commands.js'
import { linkPrompt } from './link-prompt.js'
import { livePreview } from './live-preview/index.js'

let view = null
let onChange = null

export function configure(options) {
  onChange = options.onChange ?? null
}

/// Token classes, styled in style.css: the markdown ones for prose, the rest
/// for the code inside fenced blocks.
const highlighter = tagHighlighter([
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.strikethrough, class: 'tok-strike' },
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.processingInstruction, class: 'tok-mark' },
  { tag: [tags.url, tags.labelName], class: 'tok-url' },
  { tag: tags.comment, class: 'tok-comment' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], class: 'tok-literal' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'tok-type' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'tok-function' },
  { tag: [tags.definition(tags.variableName), tags.propertyName, tags.attributeName], class: 'tok-property' },
  { tag: [tags.tagName, tags.meta], class: 'tok-meta' },
])

function extensions() {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences' }),
    // Formatting first, so Mod-I and Tab are ours rather than the defaults'
    // (select-parent and nothing, respectively). markdown() adds its own
    // keymap that continues lists on Enter and removes markers on Backspace.
    formattingKeymap,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    syntaxHighlighting(highlighter),
    livePreview(),
    linkPrompt,
    taskShortcut,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && update.view === view && onChange) onChange()
    }),
  ]
}

function teardown() {
  if (!view) return
  view.destroy()
  view = null
}

/// Replace the editor with a fresh one holding `markdown`. A fresh state
/// rather than a swapped document keeps the undo history scoped to one note.
/// Returns the markdown it now holds — the same string, as nothing normalizes
/// it — which is what later getMarkdown() calls are compared against.
export async function load(root, markdown) {
  teardown()
  root.innerHTML = ''
  view = new EditorView({
    parent: root,
    state: EditorState.create({ doc: markdown, extensions: extensions() }),
  })
  return markdown
}

export async function unload(root) {
  teardown()
  if (root) root.innerHTML = ''
}

export function getMarkdown() {
  return view ? view.state.doc.toString() : ''
}

export function isLoaded() {
  return view !== null
}

export function focus() {
  view?.focus()
}

// An ES module has no global of its own; app.js and friends are classic
// scripts, deferred so they run after this one, and find the editor here.
globalThis.NotesEditor = { configure, load, unload, getMarkdown, isLoaded, focus }
