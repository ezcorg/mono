import Link from "@tiptap/extension-link";

// dumb regex which is absolutely not guaranteed to work in all cases it may have to handle
const LINK_INPUT_REGEX = /\[([^[]+)]\((\S+)\)$/;

export const ExtendedLink = Link.extend({
    addInputRules() {
        return [
            {
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
            }
        ]
    },
})