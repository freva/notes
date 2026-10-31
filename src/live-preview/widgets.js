import { WidgetType } from '@codemirror/view'

/// Text drawn in place of its source, such as the `&` an `&amp;` stands for.
export class TextWidget extends WidgetType {
  constructor(text) {
    super()
    this.text = text
  }

  eq(other) {
    return other.text === this.text
  }

  toDOM() {
    const span = document.createElement('span')
    span.textContent = this.text
    return span
  }

  // Let a click through, so it puts the cursor here and the source comes back.
  ignoreEvent() {
    return false
  }
}

/// Disc, circle, square by nesting depth, as a browser's own <ul> draws them.
const BULLETS = ['•', '◦', '▪']

/// A list item's `-`, `*` or `+`, drawn as a bullet.
export class BulletWidget extends WidgetType {
  constructor(depth) {
    super()
    this.depth = depth
  }

  eq(other) {
    return other.depth === this.depth
  }

  toDOM() {
    const bullet = document.createElement('span')
    bullet.className = 'cm-md-list-mark cm-md-bullet'
    bullet.textContent = BULLETS[(this.depth - 1) % BULLETS.length]
    return bullet
  }

  ignoreEvent() {
    return false
  }
}

/// A task item's `- [ ]` or `- [x]`, drawn as a checkbox. Clicking it rewrites
/// the marker in the document (see `toggleTask` in ./index.js), so the change
/// is saved and undone like any typed edit.
export class TaskWidget extends WidgetType {
  constructor(checked, label) {
    super()
    this.checked = checked
    this.label = label
  }

  eq(other) {
    return other.checked === this.checked && other.label === this.label
  }

  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-list-mark'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-md-task'
    box.checked = this.checked
    // Named for the task; the box's own checked state says whether it is done.
    box.setAttribute('aria-label', this.label)
    wrap.append(box)
    return wrap
  }

  // The handlers in ./index.js own the toggle; the editor must not move the
  // cursor first.
  ignoreEvent() {
    return false
  }
}

/// A thematic break (`---`), drawn as a rule.
export class RuleWidget extends WidgetType {
  eq() {
    return true
  }

  toDOM() {
    const rule = document.createElement('span')
    rule.className = 'cm-md-rule'
    return rule
  }

  ignoreEvent() {
    return false
  }
}

/// `![alt](src)` drawn as the picture. A linked image, like a build badge,
/// carries its link's attributes so a Mod-click follows it.
export class ImageWidget extends WidgetType {
  constructor(alt, src, linkAttributes) {
    super()
    this.alt = alt
    this.src = src
    this.linkAttributes = linkAttributes
  }

  eq(other) {
    return (
      other.alt === this.alt &&
      other.src === this.src &&
      JSON.stringify(other.linkAttributes) === JSON.stringify(this.linkAttributes)
    )
  }

  toDOM(view) {
    const box = document.createElement('span')
    box.className = 'cm-md-picture'
    for (const [name, value] of Object.entries(this.linkAttributes ?? {})) {
      box.setAttribute(name, value)
    }
    const image = document.createElement('img')
    image.alt = this.alt.trim() || 'Image'
    // The line grows once the picture arrives; CodeMirror has to measure again
    // or clicks below it land on the wrong line.
    image.addEventListener('load', () => view?.requestMeasure())
    image.addEventListener('error', () => {
      box.classList.add('cm-md-picture-broken')
      box.textContent = this.alt.trim() || this.src
      view?.requestMeasure()
    })
    image.src = this.src
    box.append(image)
    return box
  }

  ignoreEvent() {
    return false
  }
}

/// A `data:` URL's text, folded to its type and size while the cursor shows
/// the image's source: the alt text stays editable, and tens of kilobytes of
/// base64 do not flood the page.
export class DataUrlWidget extends WidgetType {
  constructor(src) {
    super()
    this.src = src
  }

  eq(other) {
    return other.src === this.src
  }

  toDOM() {
    const chip = document.createElement('span')
    chip.className = 'cm-md-data-url'
    const comma = this.src.indexOf(',')
    const type = this.src.slice(5, comma).split(';')[0] || 'data'
    const payload = this.src.length - comma - 1
    const bytes = /;base64$/i.test(this.src.slice(0, comma)) ? Math.floor((payload * 3) / 4) : payload
    chip.textContent = `data:${type}, ${formatBytes(bytes)}`
    return chip
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
