import type { LanguageSupport } from '@codemirror/language';

const languageSupportCache: Record<string, LanguageSupport> = {};
const languageSupportMap: Record<string, () => Promise<LanguageSupport>> = {
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
    // Add more languages as needed
};

export const getLanguageSupport = async (language: string) => {
    if (languageSupportCache[language]) {
        return languageSupportCache[language];
    }

    const loader = languageSupportMap[language];
    if (!loader) return null;

    const support = await loader();
    languageSupportCache[language] = support;
    return support;
}