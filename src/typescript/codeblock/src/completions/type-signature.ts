/**
 * Custom autocomplete renderer that syntax-highlights type signatures
 * in the completion dropdown. Uses the same CSS custom properties as
 * the editor theme for consistent coloring.
 *
 * Designed to be passed as `addToOptions` to `serverCompletion()`.
 */
import type { Completion } from "@codemirror/autocomplete";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { StyleModule } from "style-mod";

// -------------------------------------------------------------------------
// Token types for type-signature highlighting
// -------------------------------------------------------------------------
const TYPE_KEYWORDS = new Set([
    'string', 'number', 'boolean', 'void', 'any', 'null', 'undefined',
    'never', 'object', 'unknown', 'bigint', 'symbol', 'true', 'false',
    'keyof', 'typeof', 'infer', 'extends', 'readonly', 'unique',
    'asserts', 'is', 'in', 'out', 'this',
]);

const MODIFIER_KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'method', 'property', 'class',
    'interface', 'type', 'enum', 'namespace', 'module', 'static',
    'async', 'new', 'get', 'set', 'constructor', 'abstract',
    'accessor', 'override',
]);

// Regex that tokenizes a TypeScript type expression into meaningful parts
const TOKEN_RE = /([a-zA-Z_$][\w$]*)|(\d+(?:\.\d+)?)|([():<>,\[\]|&=>{}.?;!]|=>)|(\s+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(.)/g;

function appendSpan(parent: HTMLElement, text: string, className: string) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
}

/**
 * Tokenizes and highlights a TypeScript type signature string,
 * appending styled spans to `container`.
 */
function highlightTypeSignature(container: HTMLElement, text: string) {
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(text)) !== null) {
        const [, word, num, punct, space, str, other] = match;
        if (word) {
            if (TYPE_KEYWORDS.has(word)) {
                appendSpan(container, word, 'cm-type-sig-type');
            } else if (MODIFIER_KEYWORDS.has(word)) {
                appendSpan(container, word, 'cm-type-sig-kw');
            } else {
                // Regular identifier — could be a user type, param name, etc.
                appendSpan(container, word, 'cm-type-sig-name');
            }
        } else if (num) {
            appendSpan(container, num, 'cm-type-sig-num');
        } else if (punct) {
            appendSpan(container, punct, 'cm-type-sig-punct');
        } else if (str) {
            appendSpan(container, str, 'cm-type-sig-str');
        } else if (space) {
            container.appendChild(document.createTextNode(space));
        } else if (other) {
            container.appendChild(document.createTextNode(other));
        }
    }
}

// -------------------------------------------------------------------------
// Styles — uses the same CSS custom properties as the editor theme
// -------------------------------------------------------------------------
const typeSignatureStyles = new StyleModule({
    // Hide the default plain-text detail when our renderer is active
    '.cm-tooltip-autocomplete .cm-completionDetail': {
        display: 'none !important',
    },
    '.cm-type-sig': {
        marginLeft: '0.6em',
        opacity: '0.8',
        fontSize: '0.92em',
        fontFamily: 'var(--cm-font-family)',
        whiteSpace: 'pre',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    },
    '.cm-type-sig-type': { color: 'var(--cm-type, #4ec9b0)' },
    '.cm-type-sig-kw': { color: 'var(--cm-keyword, #569cd6)' },
    '.cm-type-sig-name': { color: 'var(--cm-name, #9cdcfe)' },
    '.cm-type-sig-num': { color: 'var(--cm-number, #b5cea8)' },
    '.cm-type-sig-punct': { color: 'var(--cm-operator, #d4d4d4)', opacity: '0.7' },
    '.cm-type-sig-str': { color: 'var(--cm-string, #ce9178)' },
});

let stylesMounted = false;

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Returns an `addToOptions` entry for `serverCompletion()` that renders
 * syntax-highlighted type signatures in the autocomplete dropdown.
 *
 * Also returns a style extension that should be included in the editor.
 */
export function typeSignatureRenderer(): {
    addToOptions: { render: (completion: Completion, state: EditorState, view: EditorView) => Node | null; position: number }[];
    styles: typeof typeSignatureStyles;
} {
    return {
        addToOptions: [{
            position: 80,
            render(completion: Completion, _state: EditorState, _view: EditorView): Node | null {
                if (!completion.detail) return null;
                if (!stylesMounted) {
                    stylesMounted = true;
                    StyleModule.mount(document, typeSignatureStyles);
                }
                const span = document.createElement('span');
                span.className = 'cm-type-sig';
                highlightTypeSignature(span, completion.detail);
                return span;
            },
        }],
        styles: typeSignatureStyles,
    };
}
