import { Fs } from "../types";
import * as Comlink from 'comlink';
import { LanguageServerClient, languageServerWithClient } from "@marimo-team/codemirror-languageserver";
import { Extension } from "@codemirror/state";
import MessagePortTransport from "../rpc/transport";
import { LanguageServer } from "@volar/language-server";
import { HighlightStyle, LanguageSupport } from "@codemirror/language";
import { languageSupportCompartment, renderMarkdownCode } from "../editor";
import { EditorView } from "@codemirror/view";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import { languageServerSupport, LSPClient, Transport } from "@codemirror/lsp-client"
import markdownit from 'markdown-it'

const clients: Map<string, LanguageServerClient | LSPClient> = new Map();

export type LSPClientExtension = {
    client: LanguageServerClient | LSPClient
} & Extension

export type ClientOptions = {
    view: EditorView
    language: string,
    path: string,
    fs: Fs
}

// TODO: better fix for this reference sticking around to prevent Comlink from releasing the port
export const languageServerFactory: Map<string, (args: { fs: Fs }) => Promise<{ server: LanguageServer }>> = new Map();
export const lspWorkers: Map<string, SharedWorker> = new Map()

class TestTransport implements Transport {
    subscribers: ((msg: string) => void)[] = []

    constructor(private port: MessagePort) {
        this.port.onmessage = (ev) => {
            const message = JSON.stringify(ev.data)
            console.debug('recevied port message', message)
            this.subscribers.forEach(listener => { listener(message) })
        }

        this.port.start();
    }

    send(message: string): void {
        console.debug('sending message', message)
        this.port.postMessage(JSON.parse(message));
    }

    subscribe(listener: (msg: string) => void) {
        this.subscribers.push(listener)
    }

    unsubscribe(listener: (msg: string) => void) {
        this.subscribers = this.subscribers.filter(l => l != listener)
    }
}

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
                }
                break;
        }
        await factory?.(Comlink.proxy({ fs }))
        return { worker }
    }

    export async function client({ fs, language, path, view }: ClientOptions): Promise<LSPClientExtension> {
        let client = clients.get(language);
        let clientExtension: LSPClientExtension | undefined;
        const uri = `file:///${path}`;


        if (!client) {
            const { worker } = await LSP.worker(language, fs);
            if (!worker) return null;

            console.debug('got worker', { worker });
            await worker;

            // client = new LanguageServerClient({
            //     transport: new MessagePortTransport(worker.port),
            //     rootUri: 'file:///',
            //     workspaceFolders: [{ name: 'workspace', uri: 'file:///' }]
            // });
            const transport = new TestTransport(worker.port)
            client = new LSPClient().connect(transport)
            await client.initializing;
        }
        clients.set(language, client);
        clientExtension = { client, extension: [] };
        // clientExtension.extension = languageServerWithClient({
        //     client: clientExtension.client,
        //     documentUri: uri,
        //     languageId: language,
        //     allowHTMLContent: true,
        //     markdownRenderer(markdown) {
        //         const support = languageSupportCompartment.get(view.state) as LanguageSupport
        //         const highlighter = vscodeDark[1].find(item => item.value instanceof HighlightStyle)?.value;
        //         const parser = support.language?.parser
        //         const md = markdownit({
        //             highlight: (str: string) => {
        //                 return renderMarkdownCode(str, parser, highlighter)
        //             }
        //         })
        //         return md.render(markdown)
        //     },
        // })
        clientExtension.extension = languageServerSupport(client as LSPClient, uri);

        return clientExtension;
    }
}