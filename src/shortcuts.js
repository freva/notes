// The inline-formatting shortcuts, in one place.
//
// Most of them already come with the presets CrepeBuilder registers, so what
// is left here is the one format with no binding at all and one alias:
//
//   Mod-B        bold            commonmark  (strongKeymap)
//   Mod-I        italic          commonmark  (emphasisKeymap)
//   Mod-E        inline code     commonmark  (inlineCodeKeymap)
//   Mod-Alt-X    strikethrough   gfm         (strikethroughKeymap)
//   Mod-Shift-X  strikethrough   here        — what every other editor uses
//   Mod-K        link            here        — see link-prompt.js
//
// Mod-K is the browser's "focus search bar", but it is not a reserved
// shortcut, so returning true from the command (which makes prosemirror-keymap
// call preventDefault) is enough to keep it.

import { commandsCtx } from '@milkdown/kit/core'
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { $useKeymap } from '@milkdown/kit/utils'

import { openLinkPromptCommand } from './link-prompt.js'

const call = (command) => (ctx) => {
  const commands = ctx.get(commandsCtx)
  return () => commands.call(command.key)
}

export const formattingKeymap = $useKeymap('notesFormattingKeymap', {
  ToggleStrikethrough: {
    shortcuts: 'Mod-Shift-x',
    command: call(toggleStrikethroughCommand),
  },
  OpenLinkPrompt: {
    shortcuts: 'Mod-k',
    command: call(openLinkPromptCommand),
  },
})
