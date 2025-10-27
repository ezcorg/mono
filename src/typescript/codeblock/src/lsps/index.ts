import type { LanguageSupport } from '@codemirror/language';
import { StreamLanguage } from '@codemirror/language';

const languageSupportCache: Record<string, LanguageSupport | StreamLanguage<any>> = {};
const languageSupportMap = {
    javascript: async () => {
        const { javascript } = await import('@codemirror/lang-javascript');
        return javascript({ jsx: true, typescript: true });
    },
    python: async () => {
        const { python } = await import('@codemirror/lang-python');
        return python();
    },
    rust: async () => {
        const { rust } = await import('@codemirror/lang-rust');
        return rust();
    },
    html: async () => {
        const { html } = await import('@codemirror/lang-html');
        return html();
    },
    css: async () => {
        const { css } = await import('@codemirror/lang-css');
        return css();
    },
    scss: async () => {
        const { sass } = await import('@codemirror/lang-sass');
        return sass({ indented: false });
    },
    less: async () => {
        const { less } = await import('@codemirror/lang-less');
        return less();
    },
    json: async () => {
        const { json } = await import('@codemirror/lang-json');
        return json();
    },
    xml: async () => {
        const { xml } = await import('@codemirror/lang-xml');
        return xml();
    },
    markdown: async () => {
        const { markdown } = await import('@codemirror/lang-markdown');
        return markdown();
    },
    sql: async () => {
        const { sql } = await import('@codemirror/lang-sql');
        return sql();
    },
    php: async () => {
        const { php } = await import('@codemirror/lang-php');
        return php();
    },
    java: async () => {
        const { java } = await import('@codemirror/lang-java');
        return java();
    },
    cpp: async () => {
        const { cpp } = await import('@codemirror/lang-cpp');
        return cpp();
    },
    c: async () => {
        const { cpp } = await import('@codemirror/lang-cpp');
        return cpp();
    },
    yaml: async () => {
        const { yaml } = await import('@codemirror/lang-yaml');
        return yaml();
    },
    // Legacy modes
    ruby: async () => {
        const { ruby } = await import('@codemirror/legacy-modes/mode/ruby');
        return StreamLanguage.define(ruby);
    },
    csharp: async () => {
        const { csharp } = await import('@codemirror/legacy-modes/mode/clike');
        return StreamLanguage.define(csharp);
    },
    go: async () => {
        const { go } = await import('@codemirror/legacy-modes/mode/go');
        return StreamLanguage.define(go);
    },
    swift: async () => {
        const { swift } = await import('@codemirror/legacy-modes/mode/swift');
        return StreamLanguage.define(swift);
    },
    kotlin: async () => {
        const { kotlin } = await import('@codemirror/legacy-modes/mode/clike');
        return StreamLanguage.define(kotlin);
    },
    scala: async () => {
        const { scala } = await import('@codemirror/legacy-modes/mode/clike');
        return StreamLanguage.define(scala);
    },
    vb: async () => {
        const { vb } = await import('@codemirror/legacy-modes/mode/vb');
        return StreamLanguage.define(vb);
    },
    haskell: async () => {
        const { haskell } = await import('@codemirror/legacy-modes/mode/haskell');
        return StreamLanguage.define(haskell);
    },
    lua: async () => {
        const { lua } = await import('@codemirror/legacy-modes/mode/lua');
        return StreamLanguage.define(lua);
    },
    perl: async () => {
        const { perl } = await import('@codemirror/legacy-modes/mode/perl');
        return StreamLanguage.define(perl);
    },
    bash: async () => {
        const { shell } = await import('@codemirror/legacy-modes/mode/shell');
        return StreamLanguage.define(shell);
    },
    toml: async () => {
        const { toml } = await import('@codemirror/legacy-modes/mode/toml');
        return StreamLanguage.define(toml);
    },
    ini: async () => {
        const { properties } = await import('@codemirror/legacy-modes/mode/properties');
        return StreamLanguage.define(properties);
    },
    dockerfile: async () => {
        const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
        return StreamLanguage.define(dockerFile);
    },
    makefile: async () => {
        const { cmake } = await import('@codemirror/legacy-modes/mode/cmake');
        return StreamLanguage.define(cmake);
    },
    gitignore: async () => {
        const { properties } = await import('@codemirror/legacy-modes/mode/properties');
        return StreamLanguage.define(properties);
    }
};

export const getLanguageSupport = async (language: keyof typeof languageSupportMap) => {
    if (languageSupportCache[language]) {
        return languageSupportCache[language];
    }

    const loader = languageSupportMap[language];
    const support = await loader();
    languageSupportCache[language] = support;
    return support;
}

export type SupportedLanguage = keyof typeof languageSupportMap;
type LanguageIsSupported<T> = {
    [K in keyof T]: T[K] extends SupportedLanguage ? T[K] : never;
};
export const extOrLanguageToLanguageId = {
    javascript: 'javascript',
    js: 'javascript',
    typescript: 'javascript',
    ts: 'javascript',
    jsx: 'javascript',
    tsx: 'javascript',
    python: 'python',
    py: 'python',
    ruby: 'ruby',
    rb: 'ruby',
    php: 'php',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    csharp: 'csharp',
    cs: 'csharp',
    go: 'go',
    swift: 'swift',
    kotlin: 'kotlin',
    kt: 'kotlin',
    rust: 'rust',
    rs: 'rust',
    scala: 'scala',
    vb: 'vb',
    haskell: 'haskell',
    hs: 'haskell',
    lua: 'lua',
    perl: 'perl',
    pl: 'perl',
    bash: 'bash',
    shell: 'bash',
    sh: 'bash',
    zsh: 'bash',
    mysql: 'sql',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    markdown: 'markdown',
    md: 'markdown',
    toml: 'toml',
    ini: 'ini',
    conf: 'ini',
    log: 'ini',
    env: 'ini',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    dockerignore: 'gitignore',
    gitignore: 'gitignore',
} as const satisfies LanguageIsSupported<{
    javascript: 'javascript',
    js: 'javascript',
    typescript: 'javascript',
    ts: 'javascript',
    jsx: 'javascript',
    tsx: 'javascript',
    python: 'python',
    py: 'python',
    ruby: 'ruby',
    rb: 'ruby',
    php: 'php',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    csharp: 'csharp',
    cs: 'csharp',
    go: 'go',
    swift: 'swift',
    kotlin: 'kotlin',
    kt: 'kotlin',
    rust: 'rust',
    rs: 'rust',
    scala: 'scala',
    vb: 'vb',
    haskell: 'haskell',
    hs: 'haskell',
    lua: 'lua',
    perl: 'perl',
    pl: 'perl',
    bash: 'bash',
    shell: 'bash',
    sh: 'bash',
    zsh: 'bash',
    mysql: 'sql',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    markdown: 'markdown',
    md: 'markdown',
    toml: 'toml',
    ini: 'ini',
    conf: 'ini',
    log: 'ini',
    env: 'ini',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    dockerignore: 'gitignore',
    gitignore: 'gitignore',
}>;
export type ExtensionOrLanguage = keyof typeof extOrLanguageToLanguageId;