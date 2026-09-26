/**
 * Prose actions over a model the host provides (RFC §2: rewrite, continue,
 * summarize, an instruction of the user's; §7: the model is an interface,
 * never the editor's own). Nothing here knows which model or provider it is:
 * icanhaz's `inference` capability, a provider's API and a local model all
 * arrive as `Inference`.
 *
 * An action is asked about the selection (or the caret) and the note
 * around it. Its answer streams into a panel under the text it is about,
 * and goes into the note only when accepted, as one change undo takes back.
 * The text it is about is followed through any edit made while the answer
 * comes, and discarding stops the answer.
 */
import { Editor, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { PROSE_ACTIONS, completeText, type Inference, type ProseAction } from '@joinezco/storage'

export interface ProseAIOptions {
    /** The model. Without one, no action is offered. */
    inference?: Inference
    actions: ProseAction[]
}

export interface ProseAIStorage {
    inference?: Inference
    actions: ProseAction[]
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        proseAI: {
            /** Run a prose action on the selection (or at the caret); false
             *  when there is no model or the action needs a selection. */
            runProseAction: (id: string, instruction?: string) => ReturnType
        }
    }
}

interface Target {
    from: number
    to: number
}

/** The text an action is about, followed through every edit. */
const targetKey = new PluginKey<Target | null>('proseAITarget')

const sessions = new WeakMap<Editor, Session>()

export const ProseAI = Extension.create<ProseAIOptions, ProseAIStorage>({
    name: 'proseAI',

    addOptions() {
        return { inference: undefined, actions: PROSE_ACTIONS }
    },

    addStorage() {
        return { inference: this.options.inference, actions: this.options.actions }
    },

    addCommands() {
        return {
            runProseAction:
                (id, instruction) =>
                ({ editor, tr, dispatch }) => {
                    const inference = this.options.inference
                    const action = this.options.actions.find((a) => a.id === id)
                    if (!inference || !action) return false
                    const { from, to, empty } = tr.selection
                    if (empty && action.selection === 'required') return false
                    if (!dispatch) return true
                    // The text it is about, from this transaction on.
                    tr.setMeta(targetKey, { target: { from, to } })
                    let session = sessions.get(editor)
                    if (!session) sessions.set(editor, (session = new Session(editor, inference)))
                    // The panel opens once this command's transaction is applied.
                    queueMicrotask(() => session!.start(action, instruction))
                    return true
                },
        }
    },

    addProseMirrorPlugins() {
        const editor = this.editor
        return [
            new Plugin<Target | null>({
                key: targetKey,
                state: {
                    init: () => null,
                    apply(tr, target) {
                        const meta = tr.getMeta(targetKey) as { target: Target | null } | undefined
                        if (meta) return meta.target
                        if (!target || !tr.docChanged) return target
                        return { from: tr.mapping.map(target.from, -1), to: tr.mapping.map(target.to, 1) }
                    },
                },
                props: {
                    decorations(state) {
                        const target = targetKey.getState(state)
                        if (!target) return null
                        const mark =
                            target.from < target.to
                                ? Decoration.inline(target.from, target.to, { class: 'ezco-mde-ai-target' })
                                : Decoration.widget(target.from, () => {
                                      const caret = document.createElement('span')
                                      caret.className = 'ezco-mde-ai-caret'
                                      return caret
                                  })
                        return DecorationSet.create(state.doc, [mark])
                    },
                    handleKeyDown(_view, event) {
                        if (event.key !== 'Escape') return false
                        return sessions.get(editor)?.discard() ?? false
                    },
                },
            }),
        ]
    },

    onDestroy() {
        sessions.get(this.editor)?.destroy()
        sessions.delete(this.editor)
    },
})

/** One action at a time, in a panel under the text it is about. */
class Session {
    private readonly dom: HTMLElement
    private readonly title: HTMLElement
    private readonly ask: HTMLInputElement
    private readonly output: HTMLElement
    private readonly note: HTMLElement
    private readonly apply: HTMLButtonElement
    private readonly again: HTMLButtonElement
    private readonly discardButton: HTMLButtonElement
    private action: ProseAction | null = null
    private instruction: string | undefined
    private answer = ''
    private controller: AbortController | null = null

    constructor(
        private readonly editor: Editor,
        private readonly inference: Inference,
    ) {
        const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
            const node = document.createElement(tag)
            node.className = className
            return node
        }
        this.dom = el('div', 'ezco-mde-ai')
        this.dom.setAttribute('role', 'dialog')
        this.dom.hidden = true
        this.title = el('div', 'ezco-mde-ai-title')
        this.ask = el('input', 'ezco-mde-ai-ask')
        this.ask.placeholder = 'What should it do?'
        this.output = el('div', 'ezco-mde-ai-output')
        this.output.setAttribute('aria-live', 'polite')
        this.note = el('div', 'ezco-mde-ai-note')
        const actions = el('div', 'ezco-mde-ai-actions')
        const button = (action: string, label: string) => {
            const b = el('button', 'ezco-mde-ai-button')
            b.type = 'button'
            b.dataset.action = action
            b.textContent = label
            b.addEventListener('mousedown', (e) => e.preventDefault())
            return b
        }
        this.apply = button('apply', 'Replace')
        this.apply.disabled = true
        this.again = button('again', 'Try again')
        this.again.disabled = true
        this.discardButton = button('discard', 'Discard')
        actions.append(this.apply, this.again, this.discardButton)
        this.dom.append(this.title, this.ask, this.output, this.note, actions)

        this.apply.addEventListener('click', () => this.accept())
        this.again.addEventListener('click', () => void this.run())
        this.discardButton.addEventListener('click', () => this.discard())
        this.ask.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.ask.value.trim()) {
                e.preventDefault()
                this.instruction = this.ask.value.trim()
                void this.run()
            } else if (e.key === 'Escape') {
                e.preventDefault()
                this.discard()
            }
        })
        this.dom.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                this.discard()
            }
        })
        const host = (editor.view.dom as HTMLElement).parentElement ?? document.body
        host.append(this.dom)
    }

    start(action: ProseAction, instruction?: string) {
        const target = targetKey.getState(this.editor.state)
        if (!target) return
        this.stop()
        this.action = action
        this.instruction = instruction
        this.title.textContent = action.label.replace(/…$/, '')
        this.apply.textContent = action.placement === 'replace' && target.from < target.to ? 'Replace' : 'Insert'
        this.dom.hidden = false
        this.place()
        if (action.instruction && !instruction) {
            this.ask.hidden = false
            this.ask.value = ''
            this.output.textContent = ''
            this.note.textContent = ''
            this.apply.disabled = true
            this.again.disabled = true
            this.ask.focus()
            return
        }
        void this.run()
    }

    private async run() {
        const action = this.action
        const target = targetKey.getState(this.editor.state)
        if (!action || !target) return
        this.stop()
        this.ask.hidden = true
        this.answer = ''
        this.output.textContent = ''
        this.note.textContent = 'Writing…'
        this.apply.disabled = true
        this.again.disabled = true
        const controller = (this.controller = new AbortController())
        const markdown = (this.editor.storage as any).markdown
        const doc = this.editor.state.doc
        const selection = target.from < target.to ? markdown.serializer.serialize(doc.slice(target.from, target.to).content) : ''
        try {
            this.answer = await completeText(
                this.inference,
                action.request({
                    selection,
                    before: doc.textBetween(0, target.from, '\n\n'),
                    after: doc.textBetween(target.to, doc.content.size, '\n\n'),
                    note: markdown.getMarkdown(),
                    path: (this.editor.storage as any).persistence?.options?.filepath ?? null,
                    instruction: this.instruction,
                }),
                {
                    signal: controller.signal,
                    onText: (text) => {
                        this.output.textContent += text
                        this.place()
                    },
                },
            )
            this.answer = this.answer.trim()
            this.note.textContent = ''
            this.apply.disabled = !this.answer
            this.again.disabled = false
            // Focus stays where the person is writing: the answer is
            // announced (the output is live), and taking focus would put
            // their next keystroke on a button.
        } catch (error) {
            if ((error as Error).name === 'AbortError') return
            this.note.textContent = `The model could not answer: ${(error as Error).message}`
            this.again.disabled = false
        } finally {
            if (this.controller === controller) this.controller = null
        }
    }

    private accept() {
        const target = targetKey.getState(this.editor.state)
        const action = this.action
        if (!target || !action || !this.answer) return
        // "After" is after the block the text is in, so an answer of its own
        // paragraphs does not run on into the sentence.
        const $to = this.editor.state.doc.resolve(target.to)
        const at = action.placement === 'replace' ? { from: target.from, to: target.to } : $to.depth > 0 ? $to.after($to.depth) : target.to
        this.close()
        this.editor.chain().focus().insertContentAt(at, this.answer).run()
    }

    /** Stop and close; false when there was nothing to discard. */
    discard(): boolean {
        if (this.dom.hidden) return false
        this.close()
        this.editor.commands.focus()
        return true
    }

    private close() {
        this.stop()
        this.dom.hidden = true
        this.action = null
        if (targetKey.getState(this.editor.state)) this.editor.view.dispatch(this.editor.state.tr.setMeta(targetKey, { target: null }))
    }

    private stop() {
        this.controller?.abort()
        this.controller = null
    }

    /** Under the text the action is about. */
    private place() {
        const target = targetKey.getState(this.editor.state)
        const host = this.dom.parentElement
        if (!target || !host) return
        const end = this.editor.view.coordsAtPos(target.to)
        const box = host.getBoundingClientRect()
        this.dom.style.top = `${end.bottom - box.top + host.scrollTop + 6}px`
        this.dom.style.left = `${Math.max(0, Math.min(end.left - box.left, host.clientWidth - 360))}px`
    }

    destroy() {
        this.stop()
        this.dom.remove()
    }
}
