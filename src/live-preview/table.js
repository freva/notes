// A GFM table drawn as an HTML table while the cursor is outside it.
//
// The cells are read from the syntax tree into styled runs, so bold, italics,
// strikethrough, code and links keep their meaning, and set as text nodes —
// nothing in a cell is ever parsed as HTML.

import { WidgetType } from '@codemirror/view'

import { decodeEntity } from './text.js'

/// Nodes that only shape the source; the text a cell shows leaves them out.
const SOURCE_MARKS = new Set([
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'LinkMark',
  'LinkTitle',
  'LinkLabel',
])

/// A link or image's own URL is source; a bare URL or an autolink's is the
/// text a reader sees.
function isSourceOnly(node) {
  if (node.name === 'URL') return node.parent?.name === 'Link' || node.parent?.name === 'Image'
  return SOURCE_MARKS.has(node.name)
}

function styleOf(node, style, linkFor) {
  switch (node.name) {
    case 'StrongEmphasis':
      return { ...style, strong: true }
    case 'Emphasis':
      return { ...style, em: true }
    case 'Strikethrough':
      return { ...style, strike: true }
    case 'InlineCode':
      return { ...style, code: true }
    case 'Link':
    case 'Autolink':
    case 'URL':
      return { ...style, link: linkFor(node) ?? style.link }
    default:
      return style
  }
}

const sameStyle = (a, b) =>
  a.strong === b.strong &&
  a.em === b.em &&
  a.code === b.code &&
  a.strike === b.strike &&
  a.link?.['data-href'] === b.link?.['data-href']

/// Joins runs of one style and trims the cell's outer spaces, as a rendered
/// cell does.
function tidy(parts) {
  const joined = []
  for (const part of parts) {
    const last = joined.at(-1)
    if (last && sameStyle(last, part)) last.text += part.text
    else joined.push({ ...part })
  }
  if (joined.length) {
    joined[0].text = joined[0].text.trimStart()
    joined.at(-1).text = joined.at(-1).text.trimEnd()
  }
  return joined.filter((part) => part.text !== '')
}

/// Reads a GFM table into `{ header, body, align }`, each cell a list of
/// styled runs.
export function readTable(state, table, linkFor) {
  const collect = (node, style) => {
    const parts = []
    let pos = node.from
    for (let child = node.firstChild; child; child = child.nextSibling) {
      parts.push({ ...style, text: state.sliceDoc(pos, child.from) })
      pos = child.to
      if (child.name === 'Escape') {
        parts.push({ ...style, text: state.sliceDoc(child.from + 1, child.to) })
      } else if (child.name === 'Entity') {
        parts.push({ ...style, text: decodeEntity(state.sliceDoc(child.from, child.to)) })
      } else if (!isSourceOnly(child)) {
        parts.push(...collect(child, styleOf(child, style, linkFor)))
      }
    }
    parts.push({ ...style, text: state.sliceDoc(pos, node.to) })
    return parts
  }

  // Cells come from the delimiters' edges, so an empty cell, which has no
  // node, keeps its column. An outer pipe's empty edge is not a column.
  const cells = (row) => {
    const nodes = row.getChildren('TableCell')
    const delimiters = row.getChildren('TableDelimiter')
    const edges = [row.from, ...delimiters.flatMap((d) => [d.from, d.to]), row.to]
    const result = []
    for (let i = 0; i < edges.length; i += 2) {
      const from = edges[i]
      const to = edges[i + 1]
      const cell = nodes.find((c) => c.from >= from && c.to <= to)
      const parts = tidy(cell ? collect(cell, {}) : [{ text: state.sliceDoc(from, to) }])
      const isOuterEdge = i === 0 || i === edges.length - 2
      if (!(isOuterEdge && parts.length === 0 && !cell)) result.push(parts)
    }
    return result
  }

  const header = table.getChild('TableHeader')
  // The delimiter row (`| :- | :-: | -: |`) is the table's own
  // TableDelimiter; a row's are its pipes.
  const delimiterRow = table
    .getChildren('TableDelimiter')
    .find((node) => state.doc.lineAt(node.from).from === node.from)
  return {
    header: header ? cells(header) : [],
    body: table.getChildren('TableRow').map(cells),
    align: delimiterRow ? columnAlign(state.sliceDoc(delimiterRow.from, delimiterRow.to)) : [],
  }
}

/// Each column's alignment from the delimiter row: `:-` left, `:-:` center,
/// `-:` right.
function columnAlign(row) {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((spec) => {
      const cell = spec.trim()
      const left = cell.startsWith(':')
      const right = cell.endsWith(':')
      if (left && right) return 'center'
      if (right) return 'right'
      return left ? 'left' : null
    })
}

function partNode(part) {
  let node = document.createTextNode(part.text)
  const wrap = (tag, className) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    element.append(node)
    node = element
  }
  if (part.code) wrap('code', 'cm-md-inline-code')
  if (part.strike) wrap('s')
  if (part.em) wrap('em')
  if (part.strong) wrap('strong')
  if (part.link) {
    wrap('span', 'cm-md-link')
    for (const [name, value] of Object.entries(part.link)) node.setAttribute(name, value)
  }
  return node
}

function cellElement(tag, parts, align) {
  const cell = document.createElement(tag)
  if (align) cell.style.textAlign = align
  cell.append(...parts.map(partNode))
  return cell
}

export class TableWidget extends WidgetType {
  constructor(rows) {
    super()
    this.rows = rows
    this.key = JSON.stringify(rows)
  }

  eq(other) {
    return other.key === this.key
  }

  toDOM() {
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-md-table'
    const table = document.createElement('table')
    const head = table.createTHead().insertRow()
    const { align } = this.rows
    this.rows.header.forEach((cell, column) => head.append(cellElement('th', cell, align[column])))
    const body = table.createTBody()
    for (const row of this.rows.body) {
      const tr = body.insertRow()
      row.forEach((cell, column) => tr.append(cellElement('td', cell, align[column])))
    }
    wrapper.append(table)
    return wrapper
  }

  // Let a click through: a plain one puts the cursor in the table to edit its
  // source, a modified one on a link reaches the link handler in ./index.js.
  ignoreEvent() {
    return false
  }
}
