export { createCodeblock, codeblock, basicSetup, type CodeblockConfig, CodeblockFacet, setThemeEffect, fileChangeBus, settingsChangeBus, lineNumbersCompartment, foldGutterCompartment, toggleSvgPreviewEffect, currentFileField, persistFile, closeFile, onFileEvent, whenFileLoaded, type FileEvent } from "./editor";
export { settingsField, updateSettingsEffect, InitialSettingsFacet, type EditorSettings } from "./panels/settings";
export { registerFileAction, type FileActionEntry } from "./panels/toolbar";
export { ToolbarCore, type ToolbarHost, type ToolbarIntent, type CommandResult, type BrowseEntry, type SettingsEntry, type SearchResult, type FileResult, type HostCommand, type FileActionEntry as ToolbarFileAction, getFileIcon, setiIconForPath, SEARCH_ICON, COG_ICON, FOLDER_ICON, FOLDER_OPEN_ICON, DEFAULT_FILE_ICON, isCommandResult, isBrowseEntry, isSettingsEntry, isFileResult } from "./panels/toolbar-core";
export { LspLog, type LspLogEntry, setRemoteLspProvider, type RemoteLspProvider, type LspConnection, type ClientOptions } from "./utils/lsp";
export * from './lsps';
export { prefillTypescriptDefaults, getCachedLibFiles, getRequiredLibs, getLibFieldForTarget, type TypescriptDefaultsConfig } from './utils/typescript-defaults';
export { createAiExtension, reconfigureAi, aiCompartment } from './ai/extension';