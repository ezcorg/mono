import { VfsInterface } from "../types";
import * as Comlink from 'comlink';
import { LanguageServerClient, languageServerWithClient } from "@marimo-team/codemirror-languageserver";
import { Extension } from "@codemirror/state";
import MessagePortTransport from "../rpc/transport";
import { HighlightStyle, LanguageSupport } from "@codemirror/language";
import { languageSupportCompartment, renderMarkdownCode } from "../editor";
import { EditorView } from "@codemirror/view";
import markdownit from 'markdown-it'
import { vscodeLightDark } from "../themes/vscode";

const clients: Map<string, LanguageServerClient> = new Map();

export type LSPClientExtension = {
    client: LanguageServerClient
} & Extension

export type ClientOptions = {
    view: EditorView
    language: string,
    path: string,
    fs: VfsInterface
    libFiles?: Record<string, string>
}

// Cached factory (Comlink-wrapped) and LSP port per language
const languageServerFactory: Map<string, (fs: VfsInterface, libFiles?: Record<string, string>) => Promise<MessagePort>> = new Map();
const lspPorts: Map<string, MessagePort> = new Map();
export const lspWorkers: Map<string, SharedWorker> = new Map()

export namespace LSP {
    export async function worker(language: string, fs: VfsInterface, libFiles?: Record<string, string>): Promise<{ worker: SharedWorker, lspPort: MessagePort }> {
        let factory: ((fs: VfsInterface, libFiles?: Record<string, string>) => Promise<MessagePort>) | undefined;
        let worker: SharedWorker | undefined;

        switch (language) {
            case 'javascript':
            case 'typescript':
                factory = languageServerFactory.get('javascript')
                worker = lspWorkers.get('javascript')

                if (!factory) {
                    worker = new SharedWorker(new URL('../workers/javascript.worker.js', import.meta.url), { type: 'module' });
                    worker.port.start();
                    lspWorkers.set('javascript', worker)
                    const wrapped = Comlink.wrap<{ createLanguageServer: (fs: VfsInterface, libFiles?: Record<string, string>) => Promise<MessagePort> }>(worker.port);
                    factory = wrapped.createLanguageServer
                    languageServerFactory.set('javascript', factory)
                }
                break;
        }
        // fs is proxied (has methods), libFiles is plain data (structured clone)
        // The factory returns a MessagePort for the LSP connection (separate from Comlink's port)
        const lspPort = await factory!(Comlink.proxy(fs), libFiles);
        lspPort.start();
        lspPorts.set(language, lspPort);
        return { worker: worker!, lspPort }
    }

    export async function client({ fs, language, path, view, libFiles }: ClientOptions): Promise<LSPClientExtension> {
        let client = clients.get(language);
        let clientExtension: LSPClientExtension | undefined;
        const uri = `file:///${path}`;

        if (!client) {
            const { lspPort } = await LSP.worker(language, fs, libFiles);
            if (!lspPort) return null;

            client = new LanguageServerClient({
                transport: new MessagePortTransport(lspPort),
                rootUri: 'file:///',
                workspaceFolders: [{ name: 'workspace', uri: 'file:///' }]
            });
        }
        clients.set(language, client);
        clientExtension = { client, extension: [] };
        clientExtension.extension = languageServerWithClient({
            client: clientExtension.client,
            documentUri: uri,
            languageId: language,
            allowHTMLContent: true,
            markdownRenderer(markdown) {
                const support = languageSupportCompartment.get(view.state) as LanguageSupport
                const highlighter = vscodeLightDark[1].find(item => item.value instanceof HighlightStyle)?.value;
                const parser = support.language?.parser
                const md = markdownit({
                    highlight: (str: string) => {
                        return renderMarkdownCode(str, parser, highlighter)
                    }
                })
                return md.render(markdown)
            },
        })

        return clientExtension;
    }
}
