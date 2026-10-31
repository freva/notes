/// One HTML entity (`&amp;`, `&#38;`, `&#x26;`) as the text it stands for,
/// decoded by the browser's own table. A <textarea> holds raw text, so nothing
/// in it is parsed as markup or run.
export function decodeEntity(entity) {
  const area = document.createElement('textarea')
  area.innerHTML = entity
  return area.value
}

/// A backslash escape of ASCII punctuation, or an entity, as CommonMark
/// recognizes them.
const ESCAPE_OR_ENTITY =
  /\\([!-/:-@[-`{-~])|(&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z][a-zA-Z\d]{1,31});)/g

/// Markdown source as a reader sees it: `\*` reads `*` and `&amp;` reads `&`.
export function markdownText(source) {
  return source.replace(ESCAPE_OR_ENTITY, (_match, escaped, entity) =>
    escaped ?? decodeEntity(entity ?? '')
  )
}
