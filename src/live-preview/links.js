import { markdownText } from './text.js'

const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'

/// The key a reference link matches its definition by: brackets, case and
/// inner spacing do not count.
export function referenceKey(label) {
  return label
    .replace(/^\[|\]$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/// A parsed destination as the browser takes it. The parser keeps the `<...>`
/// that lets a destination hold spaces, and its backslash escapes and
/// entities, so the delimiters come off, `\(` and `&amp;` decode, and the
/// spaces are encoded.
export function normalizeDestination(raw) {
  const bare = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
  return markdownText(bare).replace(/\s/g, (space) => encodeURIComponent(space))
}

/// Where an autolink or a bare URL goes: an email address gets `mailto:`, a
/// `www.` one `http://`.
export function autolinkHref(text) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^www\./i.test(text)) return `http://${text}`
  return text.includes('@') ? `mailto:${text}` : text
}

/// The attributes that make a span followable (see the handlers in
/// ./index.js), for web and mail links only; anything else stays text. The
/// title shows the URL the rendered text hides.
export function linkAttributes(href) {
  if (!/^(https?:|mailto:)/i.test(href)) return undefined
  return { 'data-href': href, title: `${href} (${MOD_LABEL}-click to open)` }
}

/// The URL of the followable element an event happened in, if any.
export function linkTarget(target) {
  return target instanceof Element ? target.closest('[data-href]')?.dataset.href : undefined
}
