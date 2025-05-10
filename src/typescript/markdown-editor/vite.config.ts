import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@codemirror/state': path.resolve(__dirname, './node_modules/@codemirror/state'),
      '@codemirror/view': path.resolve(__dirname, './node_modules/@codemirror/view'),
      '@codemirror/language': path.resolve(__dirname, './node_modules/@codemirror/language'),
    }
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, './src/components/editor/index.tsx'),
      name: 'MarkdownEditor',
      fileName: (format) => `markdown-editor.${format}.js`,
    },
  },
  plugins: [
    react()
  ],
})
