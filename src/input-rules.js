// Two input rules Milkdown does not ship.
//
// Both are plain ProseMirror InputRules wrapped in $inputRule so they can be
// handed to editor.use(); they fire while you type, which is the whole point of
// a live-preview editor.

import {
  bulletListSchema,
  linkSchema,
  listItemSchema,
} from '@milkdown/kit/preset/commonmark'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { findWrapping } from '@milkdown/kit/prose/transform'
import { $inputRule } from '@milkdown/kit/utils'

/// `[] `, `[ ] ` or `[x] ` starts a task item.
///
/// GFM's own rule (wrapInTaskListInputRule) requires the brackets to be
/// non-empty *and* the cursor to already be inside a list item, so you had to
/// type `- ` first and could never write the empty `[]` form. This replaces it:
/// inside a list item it just sets the attribute, and in a bare paragraph it
/// wraps the block in a bullet list on the way.
export const taskListInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^\[(?<checked>[ xX]?)\]\s$/, (state, match, start, end) => {
      const checked = match.groups?.checked.toLowerCase() === 'x'
      const listItem = listItemSchema.type(ctx)
      const $start = state.doc.resolve(start)

      // Already a list item — drop the typed text and set the attribute. Note
      // there is deliberately no "already a task item" bail here (gfm's rule
      // has one): pressing Enter in a task item makes another unchecked task
      // item, and typing `[x] ` there means "mark this one done", not "insert
      // the literal text [x]".
      for (let depth = $start.depth; depth > 0; depth--) {
        const node = $start.node(depth)
        if (node.type !== listItem) continue

        return state.tr
          .deleteRange(start, end)
          .setNodeMarkup($start.before(depth), undefined, {
            ...node.attrs,
            checked,
          })
      }

      // A bare paragraph — wrap it in bullet_list > list_item first. Delete the
      // typed text up front so the wrap operates on the paragraph as it will
      // end up, then re-resolve because the positions have shifted.
      const tr = state.tr.deleteRange(start, end)
      const range = tr.doc.resolve(tr.mapping.map(start)).blockRange()
      const wrapping = range && findWrapping(range, bulletListSchema.type(ctx))
      if (!wrapping) return null
      tr.wrap(range, wrapping)

      const $wrapped = tr.doc.resolve(tr.mapping.map(start))
      for (let depth = $wrapped.depth; depth > 0; depth--) {
        const node = $wrapped.node(depth)
        if (node.type !== listItem) continue
        return tr.setNodeMarkup($wrapped.before(depth), undefined, {
          ...node.attrs,
          checked,
        })
      }
      return null
    })
)

/// `[text](https://example.com)` becomes a link as you close the paren.
///
/// Commonmark ships input rules for bold, italic, code, headings, lists,
/// blockquote, hr and code fences — but not for links, so without this the
/// markdown just sits there as literal text and gets backslash-escaped on save.
export const linkInputRule = $inputRule(
  (ctx) =>
    new InputRule(
      /\[([^\]]+)]\((\S+?)(?:\s+"([^"]*)")?\)$/,
      (state, match, start, end) => {
        const [, text, href, title] = match
        const link = linkSchema.type(ctx).create({ href, title: title ?? null })

        return (
          state.tr
            .replaceWith(start, end, state.schema.text(text, [link]))
            // Otherwise the next thing you type keeps the link mark.
            .removeStoredMark(linkSchema.type(ctx))
        )
      }
    )
)
