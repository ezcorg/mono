// Public library surface for @joinezco/icanhaz-web.

export { Session, openTerminal } from "./client";
export type { ConnectOptions, TerminalHandle } from "./client";

export { createTerminalBlock } from "./terminal-block";
export type { TerminalBlockOptions, MountTerminal } from "./terminal-block";

export { mountXterm, createXtermTerminalBlock } from "./xterm-view";
