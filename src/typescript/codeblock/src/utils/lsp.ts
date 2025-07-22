import { Fs } from "../types";
import * as Comlink from 'comlink';
import { LanguageServerClient, languageServerWithClient } from "@marimo-team/codemirror-languageserver";
import { Extension } from "@codemirror/state";
import MessagePortTransport from "../rpc/transport";
import { LanguageServer } from "@volar/language-server";

const clients: Map<string, LSPClientExtension> = new Map();

export type LSPClientExtension = {
    client: LanguageServerClient
} & Extension

// TODO: better fix for this reference sticking around to prevent Comlink from releasing the port
export const languageServerFactory: Map<string, (args: { fs: Fs }) => Promise<{ server: LanguageServer }>> = new Map();
export const lspWorkers: Map<string, SharedWorker> = new Map()

export namespace LSP {
    export async function worker(language: string, fs: Fs): Promise<{ worker: SharedWorker }> {
        let factory, worker;

        console.debug('language', { language })

        switch (language) {
            case 'javascript':
            case 'typescript':
                factory = languageServerFactory.get('javascript')
                worker = lspWorkers.get('javascript')
                console.debug('got worker', { worker, factory })

                if (!factory) {
                    worker = new SharedWorker(new URL('../workers/javascript.worker.js', import.meta.url), { type: 'module' });
                    worker.port.start();
                    lspWorkers.set('javascript', worker)
                    const { createLanguageServer } = Comlink.wrap<{ createLanguageServer: (args: { fs: Fs }) => Promise<{ server: LanguageServer }> }>(worker.port);
                    factory = createLanguageServer
                    languageServerFactory.set('javascript', factory)
                    await factory(Comlink.proxy({ fs }))
                }
                break;
        }
        return { worker }
    }

    export async function client(language: string, path: string, fs: Fs): Promise<LSPClientExtension> {
        let ext = clients.get(language)

        if (!ext) {
            const { worker } = await LSP.worker(language, fs)

            if (!worker) {
                return null
            }

            console.debug('got worker', { worker })
            const transport = new MessagePortTransport(worker.port);
            const client = new LanguageServerClient({
                transport,
                rootUri: 'file:///',
                workspaceFolders: [{ name: 'workspace', uri: 'file:///' }]
            });
            // await client.initialize()

            const uri = `file:///${path}`
            const extension = languageServerWithClient({
                client,
                documentUri: uri,
                languageId: language,
                allowHTMLContent: true,
                // renderMarkdown(content) {
                //     const contentString = (content as MarkupContent).kind !== undefined ? (content as MarkupContent).value : content.toString()
                //     const support = languageSupportCompartment.get(view.state) as LanguageSupport
                //     const highlighter = vscodeDark[1].find(item => item.value instanceof HighlightStyle)?.value;
                //     const parser = support.language?.parser
                //     const md = markdownit({
                //         highlight: (str: string) => {
                //             return renderMarkdownCode(str, parser, highlighter)
                //         }
                //     })
                //     return md.render(contentString)
                // },
            })
            ext = {
                client,
                extension
            }
            clients.set(language, ext)
        }
        return ext;
    }
}