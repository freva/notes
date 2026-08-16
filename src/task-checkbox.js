// Click-to-toggle for GFM task checkboxes.
//
// The obvious way to get this is crepe's `list-item` feature, but its node view
// has a race: on mount it captures view.state.selection and re-dispatches it a
// requestAnimationFrame later without mapping through the steps applied in
// between, so anything typed during that frame lands at the stale offset. Type
// "[x] hello" quickly and you get "[x] ello...h". It affects Milkdown's own
// `1. ` rule too, so it is not something we can dodge by creating list items
// differently — the only way out is to not have the node view.
//
// So the checkbox stays a CSS ::before on li[data-checked] (see style.css) and
// this plugin makes it clickable. Bonus: real <ul> markers keep working, so
// bullets still cycle disc / circle / square with nesting depth.

import { listItemSchema } from '@milkdown/kit/preset/commonmark'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

// The box is drawn outside the <li> content box (it sits in the list's marker
// gutter), so hit-testing it means asking the browser where the pseudo-element
// actually ended up rather than hard-coding the offsets a second time here.
const SLOP = 3

function hitsCheckbox(li, event) {
  const box = getComputedStyle(li, '::before')
  const rect = li.getBoundingClientRect()
  const left = rect.left + parseFloat(box.left)
  const top = rect.top + parseFloat(box.top)
  const width = parseFloat(box.width)
  const height = parseFloat(box.height)
  if ([left, top, width, height].some(Number.isNaN)) return false

  return (
    event.clientX >= left - SLOP &&
    event.clientX <= left + width + SLOP &&
    event.clientY >= top - SLOP &&
    event.clientY <= top + height + SLOP
  )
}

export const taskCheckboxClick = $prose(
  (ctx) =>
    new Plugin({
      key: new PluginKey('notesTaskCheckboxClick'),
      props: {
        handleDOMEvents: {
          mousedown: (view, event) => {
            if (!view.editable || event.button !== 0) return false

            const li = event.target?.closest?.('li[data-checked]')
            if (!li || !hitsCheckbox(li, event)) return false

            const pos = view.posAtDOM(li, 0)
            if (pos == null || pos < 0) return false

            const $pos = view.state.doc.resolve(pos)
            for (let depth = $pos.depth; depth >= 0; depth--) {
              const node = $pos.node(depth)
              if (node.type !== listItemSchema.type(ctx)) continue
              if (node.attrs.checked == null) return false

              view.dispatch(
                view.state.tr.setNodeMarkup($pos.before(depth), undefined, {
                  ...node.attrs,
                  checked: !node.attrs.checked,
                })
              )
              // Swallow the event so the caret does not also move into the item.
              event.preventDefault()
              return true
            }
            return false
          },
        },
      },
    })
)
