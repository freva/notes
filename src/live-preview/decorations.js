// What the live preview draws, and when the source comes back.
//
// Markdown is drawn as it renders, with the source of a construct shown again
// while the cursor is in it, so it can be edited. Line marks (`#`, `>`, `-`)
// come back for the cursor's line, inline marks (`**`, `` ` ``, a link's URL)
// for the span the cursor touches, and a code block or table for the whole
// block.
//
// `focused` matters because the cursor sits at the start of the file before
// anyone clicks in: an unfocused editor reveals nothing, so a note opens
// looking fully rendered.

import { syntaxTree } from '@codemirror/language'
import { Decoration } from '@codemirror/view'

import { autolinkHref, linkAttributes, normalizeDestination, referenceKey } from './links.js'
import { readTable, TableWidget } from './table.js'
import { decodeEntity, markdownText } from './text.js'
import {
  BulletWidget,
  DataUrlWidget,
  ImageWidget,
  RuleWidget,
  TaskWidget,
  TextWidget,
} from './widgets.js'

const ATX_HEADING = /^ATXHeading([1-6])$/
const SETEXT_HEADING = /^SetextHeading([12])$/

const hidden = Decoration.replace({})

/// Nodes that draw the URL inside them; any other URL is a bare address.
const URL_OWNERS = new Set(['Link', 'Image', 'Autolink', 'LinkReference'])

export function buildLivePreview(state, focused) {
  return new LivePreviewBuilder(state, focused).build()
}

function listDepth(item) {
  let depth = 0
  for (let parent = item.parent; parent; parent = parent.parent) {
    if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth++
  }
  return depth
}

class LivePreviewBuilder {
  constructor(state, focused) {
    this.state = state
    this.focused = focused
    this.ranges = []
    /// Each list line by line number, from the innermost item that holds it.
    this.listLines = new Map()
    /// Reference definitions (`[site]: https://...`) by referenceKey, the
    /// first one for a label.
    this.definitions = new Map()
  }

  build() {
    this.collectDefinitions()
    syntaxTree(this.state).iterate({ enter: (ref) => this.visit(ref.node) })
    this.drawListLines()
    return Decoration.set(this.ranges, true)
  }

  /// Decorates one node; `false` skips its children, which the node has
  /// already drawn.
  visit(node) {
    const atx = ATX_HEADING.exec(node.name)
    if (atx) return this.atxHeading(node, Number(atx[1]))
    const setext = SETEXT_HEADING.exec(node.name)
    if (setext) return this.setextHeading(node, Number(setext[1]))

    switch (node.name) {
      case 'Emphasis':
      case 'StrongEmphasis':
      case 'Strikethrough':
        if (!this.isActive(node.from, node.to)) {
          const markName = node.name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark'
          for (const mark of node.getChildren(markName)) this.hide(mark.from, mark.to)
        }
        return
      case 'InlineCode':
        this.mark(node.from, node.to, 'cm-md-inline-code')
        if (!this.isActive(node.from, node.to)) {
          for (const mark of node.getChildren('CodeMark')) this.hide(mark.from, mark.to)
        }
        return
      case 'Link':
        return this.link(node)
      case 'Autolink':
        return this.autolink(node)
      case 'URL':
        // A bare `https://`, `www.` or email address; the others draw their own.
        if (!URL_OWNERS.has(node.parent?.name ?? '')) {
          this.mark(node.from, node.to, 'cm-md-link', this.linkFor(node))
        }
        return
      case 'Image':
        return this.image(node)
      case 'Escape':
        if (!this.isActive(node.from, node.to)) this.hide(node.from, node.from + 1)
        return
      case 'Entity':
        if (!this.isActive(node.from, node.to)) {
          const text = decodeEntity(this.state.sliceDoc(node.from, node.to))
          this.replace(node.from, node.to, new TextWidget(text))
        }
        return
      case 'LinkReference':
        this.linkDefinition(node)
        return false
      case 'ListItem':
        this.listItem(node)
        return
      case 'ListMark':
        this.listMark(node)
        return
      case 'Blockquote':
        this.lines(node.from, node.to, 'cm-md-quote')
        return
      case 'QuoteMark':
        if (!this.isActiveLines(node.from, node.from)) this.hideWithSpace(node)
        return
      case 'FencedCode':
        return this.fencedCode(node)
      case 'CodeBlock':
        this.indentedCode(node)
        return false
      case 'HorizontalRule':
        if (!this.isActiveLines(node.from, node.to)) {
          this.replace(node.from, node.to, new RuleWidget())
        }
        return false
      case 'Table':
        return this.table(node)
    }
  }

  atxHeading(node, level) {
    this.lines(node.from, node.from, `cm-md-heading cm-md-h${level}`)
    if (this.isActiveLines(node.from, node.to)) return true
    for (const mark of node.getChildren('HeaderMark')) {
      if (mark.from === node.from) this.hideWithSpace(mark)
      else this.hide(this.skipSpaceBack(mark.from, node.from), mark.to) // A closing `##`.
    }
    return true
  }

  setextHeading(node, level) {
    const underline = node.getChild('HeaderMark')
    const textEnd = underline ? this.state.doc.lineAt(underline.from).from - 1 : node.to
    this.lines(node.from, textEnd, `cm-md-heading cm-md-h${level}`)
    if (underline) {
      this.lines(underline.from, underline.from, 'cm-md-setext-mark')
      if (!this.isActiveLines(node.from, node.to)) {
        this.hide(underline.from, underline.to)
        // Hidden, its text would still leave an empty row under the title.
        this.lines(underline.from, underline.from, 'cm-md-line-collapsed')
      }
    }
    return true
  }

  link(node) {
    const href = this.destination(node)
    // `[text]` that names no URL or definition is a plain bracket in prose.
    if (href == null) return

    const [open, close] = node.getChildren('LinkMark')
    const textFrom = open.to
    const textTo = close?.from ?? node.to
    this.mark(textFrom, textTo, 'cm-md-link', linkAttributes(href))
    if (!this.isActive(node.from, node.to)) {
      this.hide(node.from, textFrom)
      this.hide(textTo, node.to)
    }
  }

  /// Where a link or image points: its own URL, or the URL of the definition
  /// its label names. A collapsed `[Site][]` or a shortcut `[site]` names a
  /// definition by its text.
  destination(node) {
    const url = node.getChild('URL')
    if (url) return normalizeDestination(this.state.sliceDoc(url.from, url.to))
    const [open, close] = node.getChildren('LinkMark')
    const label = node.getChild('LinkLabel')
    const named = label ? referenceKey(this.state.sliceDoc(label.from, label.to)) : ''
    const key = named || (close ? referenceKey(this.state.sliceDoc(open.to, close.from)) : '')
    return key ? this.definitions.get(key) : undefined
  }

  collectDefinitions() {
    syntaxTree(this.state).iterate({
      enter: (ref) => {
        if (ref.name !== 'LinkReference') return
        const label = ref.node.getChild('LinkLabel')
        const url = ref.node.getChild('URL')
        const key = label ? referenceKey(this.state.sliceDoc(label.from, label.to)) : ''
        if (url && key && !this.definitions.has(key)) {
          this.definitions.set(key, normalizeDestination(this.state.sliceDoc(url.from, url.to)))
        }
        return false
      },
    })
  }

  /// A reference definition stays visible, muted, rather than hidden: it is a
  /// line of the note someone may need to edit, and a hidden line cannot be
  /// clicked into.
  linkDefinition(node) {
    this.lines(node.from, node.to, 'cm-md-link-definition')
    const url = node.getChild('URL')
    if (url) {
      const href = normalizeDestination(this.state.sliceDoc(url.from, url.to))
      this.mark(url.from, url.to, 'cm-md-link', linkAttributes(href))
    }
  }

  /// What a Link, Autolink or bare URL node follows to, as linkAttributes.
  linkFor(node) {
    if (node.name === 'Link') {
      const href = this.destination(node)
      return href == null ? undefined : linkAttributes(href)
    }
    const url = node.name === 'URL' ? node : node.getChild('URL')
    return url ? linkAttributes(autolinkHref(this.state.sliceDoc(url.from, url.to))) : undefined
  }

  autolink(node) {
    const url = node.getChild('URL')
    if (url) this.mark(url.from, url.to, 'cm-md-link', this.linkFor(node))
    if (!this.isActive(node.from, node.to)) {
      for (const mark of node.getChildren('LinkMark')) this.hide(mark.from, mark.to)
    }
    return false
  }

  image(node) {
    const src = this.destination(node)
    // `![x]` that names no URL or definition is text, as a bare `[x]` is.
    if (src == null) return true
    const [open, close] = node.getChildren('LinkMark')
    const url = node.getChild('URL')
    const alt = close ? markdownText(this.state.sliceDoc(open.to, close.from)) : ''
    if (this.isActive(node.from, node.to)) {
      if (url && src.startsWith('data:')) this.replace(url.from, url.to, new DataUrlWidget(src))
      return false
    }
    // A linked image, like a build badge, follows its link.
    const outer = node.parent?.name === 'Link' ? this.destination(node.parent) : undefined
    const link = outer == null ? undefined : linkAttributes(outer)
    this.replace(node.from, node.to, new ImageWidget(alt, src, link))
    return false
  }

  /// Notes an item's lines for drawListLines. The tree visits an outer item
  /// before the items inside it, so a nested item's lines end up at its own
  /// depth.
  listItem(node) {
    const depth = listDepth(node)
    const { doc } = this.state
    const first = doc.lineAt(node.from).number
    for (let line = first; line <= doc.lineAt(node.to).number; line++) {
      this.listLines.set(line, { depth, first: line === first })
    }
  }

  /// Indents each list line by its depth and hangs an item's marker in front
  /// of its text, so wrapped lines line up under the text. The source's own
  /// indentation is hidden, since the depth draws it; a code block inside an
  /// item keeps its spaces.
  drawListLines() {
    const { doc } = this.state
    for (const [number, { depth, first }] of this.listLines) {
      const line = doc.line(number)
      this.ranges.push(
        Decoration.line({
          class: first ? 'cm-md-list-line cm-md-list-first' : 'cm-md-list-line',
          attributes: { style: `--md-list-depth: ${depth}` },
        }).range(line.from)
      )
      const indent = /^ */.exec(line.text)[0].length
      if (indent > 0 && !this.inCode(line.from + indent)) this.hide(line.from, line.from + indent)
    }
  }

  inCode(pos) {
    for (let node = syntaxTree(this.state).resolveInner(pos, 1); node; node = node.parent) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true
    }
    return false
  }

  listMark(node) {
    const item = node.parent
    const task = item?.getChild('Task')
    const marker = task?.getChild('TaskMarker')
    // The space after the mark sits in the marker's box, so the text starts
    // at the same place with the source shown or drawn.
    const end = this.state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
    const checked = marker != null && /x/i.test(this.state.sliceDoc(marker.from, marker.to))
    if (checked) {
      const line = this.state.doc.lineAt(marker.to)
      this.mark(marker.to, line.to, 'cm-md-task-done')
    }

    if (this.isActiveLines(node.from, node.from)) {
      this.mark(node.from, end, 'cm-md-list-mark')
      return
    }
    if (task && marker) {
      const line = this.state.doc.lineAt(marker.to)
      const label = line.text.slice(marker.to - line.from).trim()
      // The space after `]` goes too, the box's margin stands in for it.
      const markerEnd = this.state.sliceDoc(marker.to, marker.to + 1) === ' ' ? marker.to + 1 : marker.to
      this.replace(node.from, markerEnd, new TaskWidget(checked, label || 'Task'))
    } else if (item?.parent?.name === 'BulletList') {
      this.replace(node.from, end, new BulletWidget(listDepth(item)))
    } else {
      this.mark(node.from, end, 'cm-md-list-mark')
    }
  }

  fencedCode(node) {
    const marks = node.getChildren('CodeMark')
    this.codeBlockLines(node)
    this.lines(node.from, node.from, 'cm-md-code-fence')
    // An unclosed fence runs to the end of the note, so its last line is
    // code, not a fence.
    if (marks.length > 1) this.lines(node.to, node.to, 'cm-md-code-fence')
    if (!this.isActiveLines(node.from, node.to)) {
      // A fence drawn as an empty line would pad the block with a blank row;
      // collapsed, it is the block's top and bottom padding.
      this.lines(node.from, node.from, 'cm-md-code-fence-collapsed')
      if (marks.length > 1) this.lines(node.to, node.to, 'cm-md-code-fence-collapsed')
      for (const mark of marks) this.hide(mark.from, mark.to)
      const info = node.getChild('CodeInfo')
      if (info) this.hide(info.from, info.to)
      // A fence inside a quote carries the quote's `>` on every line; the
      // children are skipped below, so those are hidden here.
      for (const mark of node.getChildren('QuoteMark')) this.hideWithSpace(mark)
    }
    return false
  }

  /// An indented code block: its four-space (or tab) prefix only marks it as
  /// code, so it hides.
  indentedCode(node) {
    this.codeBlockLines(node)
    if (this.isActiveLines(node.from, node.to)) return
    const { doc } = this.state
    for (let number = doc.lineAt(node.from).number; number <= doc.lineAt(node.to).number; number++) {
      const line = doc.line(number)
      const prefix = /^(\t| {1,4})/.exec(line.text)?.[0].length ?? 0
      this.hide(line.from, line.from + prefix)
    }
  }

  codeBlockLines(node) {
    this.lines(node.from, node.to, 'cm-md-code-block')
    this.lines(node.from, node.from, 'cm-md-code-start')
    this.lines(node.to, node.to, 'cm-md-code-end')
  }

  table(node) {
    // A table inside a quote or list shares its lines with the `>` or `-`
    // before it, which a whole-line widget would swallow, so it stays source.
    if (node.parent?.name !== 'Document' || this.isActiveLines(node.from, node.to)) {
      this.lines(node.from, node.to, 'cm-md-table-source')
      return false
    }
    const rows = readTable(this.state, node, (child) => this.linkFor(child))
    const { doc } = this.state
    this.ranges.push(
      Decoration.replace({ widget: new TableWidget(rows), block: true }).range(
        doc.lineAt(node.from).from,
        doc.lineAt(node.to).to
      )
    )
    return false
  }

  isActive(from, to) {
    return (
      this.focused &&
      this.state.selection.ranges.some((range) => range.from <= to && range.to >= from)
    )
  }

  isActiveLines(from, to) {
    const { doc } = this.state
    return this.isActive(doc.lineAt(from).from, doc.lineAt(to).to)
  }

  lines(from, to, className) {
    const { doc } = this.state
    const decoration = Decoration.line({ class: className })
    for (let line = doc.lineAt(from).number; line <= doc.lineAt(to).number; line++) {
      this.ranges.push(decoration.range(doc.line(line).from))
    }
  }

  mark(from, to, className, attributes) {
    if (to > from) this.ranges.push(Decoration.mark({ class: className, attributes }).range(from, to))
  }

  replace(from, to, widget) {
    this.ranges.push(Decoration.replace({ widget }).range(from, to))
  }

  hide(from, to) {
    if (to > from) this.ranges.push(hidden.range(from, to))
  }

  /// Hides a line mark and the space that follows it, so `# Title` lines up
  /// with body text.
  hideWithSpace(node) {
    const end = this.state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
    this.hide(node.from, end)
  }

  skipSpaceBack(pos, limit) {
    let start = pos
    while (start > limit && this.state.sliceDoc(start - 1, start) === ' ') start--
    return start
  }
}
