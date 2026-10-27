import { InputRule, nodeInputRule } from '@tiptap/core'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import { asksForFrontMatter } from './front-matter'

/**
 * StarterKit's divider, with its input rule held off for `---` typed as the
 * first line of a note that has no front matter: there the dashes may be
 * the start of the note's properties, which are written the same way, so
 * they stay text and the front matter extension asks which was meant
 * (front-matter.ts). Anywhere else `---`, `___` and `***` make a divider as
 * they always did.
 */
export const ExtendedHorizontalRule = HorizontalRule.extend({
    addInputRules() {
        const rule = nodeInputRule({ find: /^(?:---|—-|___\s|\*\*\*\s)$/, type: this.type })
        return [
            new InputRule({
                find: rule.find,
                handler: (props) => (asksForFrontMatter(props.state, props.range, props.match[0]) ? null : rule.handler(props)),
            }),
        ]
    },
})
