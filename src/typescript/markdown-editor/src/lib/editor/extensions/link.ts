import Link, { type LinkOptions } from "@tiptap/extension-link";
import { InputRule } from "@tiptap/core";

// dumb regex which is absolutely not guaranteed to work in all cases it may have to handle
const LINK_INPUT_REGEX = /\[([^[]+)]\((\S+)\)$/;

export const ExtendedLink = Link.extend({
    addOptions() {
        return {
            ...(this.parent?.() as LinkOptions),
            // A plain click should place the caret, not navigate. Following a
            // link is a deliberate gesture (⌘/Ctrl-click, the inline popover's
            // Open button, or Mod-Enter) — see extensions/link-menu.ts.
            openOnClick: false,
        };
    },

    addInputRules() {
        return [
            new InputRule({   // the class, not a bare object: tiptap 3.31 added fields (undoable) it fills in itself
                find: LINK_INPUT_REGEX,
                handler: ({ range, match, chain }) => {
                    const [, text, href] = match
                    const { from, to } = range

                    // Replace the markdown link with the plain text and apply the link mark
                    chain()
                        .insertContentAt({ from, to }, text)
                        .command(({ tr, state }) => {
                            tr.addMark(
                                from,
                                from + text.length,
                                state.schema.marks.link.create({ href })
                            )
                            return true
                        })
                        .run()
                },
            }),
        ]
    },
})