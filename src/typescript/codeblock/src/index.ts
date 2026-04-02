export { createCodeblock, codeblock, basicSetup, type CodeblockConfig, CodeblockFacet, setThemeEffect, fileChangeBus, settingsChangeBus, lineNumbersCompartment, foldGutterCompartment, toggleSvgPreviewEffect } from "./editor";
export { settingsField, updateSettingsEffect, InitialSettingsFacet, type EditorSettings } from "./panels/settings";
export { registerFileAction, type FileActionEntry } from "./panels/toolbar";
export { ToolbarCore, type ToolbarHost, type ToolbarIntent, type CommandResult, type BrowseEntry, type SettingsEntry, type SearchResult, type FileActionEntry as ToolbarFileAction, getFileIcon, setiIconForPath, SEARCH_ICON, COG_ICON, FOLDER_ICON, FOLDER_OPEN_ICON, DEFAULT_FILE_ICON, TERMINAL_ICON, isCommandResult, isBrowseEntry, isSettingsEntry } from "./panels/toolbar-core";
export { LspLog, type LspLogEntry } from "./utils/lsp";
export { Vfs as CodeblockFS } from './utils/fs';

export * from './utils/snapshot';
export * from './types';
export * from './utils/search';
export * from './lsps';
export { prefillTypescriptDefaults, getCachedLibFiles, getRequiredLibs, getLibFieldForTarget, type TypescriptDefaultsConfig } from './utils/typescript-defaults';
export { LazyVfs } from './utils/lazy-vfs';
export { ChunkFetcher } from './utils/chunk-fetcher';
export { type LazyManifest, loadManifest, buildDirectoryTree, getChunkUrl, getFilesInChunk } from './utils/lazy-manifest';
export { createAiExtension, reconfigureAi, aiCompartment } from './ai/extension';