import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalBlock, type MountTerminal, type TerminalBlockOptions } from "./terminal-block";

/** The default terminal renderer: xterm.js bound to a NoCap `TerminalHandle`. */
export const mountXterm: MountTerminal = (container, handle) => {
  const term = new Terminal({
    fontFamily: "Menlo, Monaco, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: { background: "#1e1e1e" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  handle.onOutput((bytes) => term.write(bytes));
  const dataSub = term.onData((data) => handle.write(data));
  const resizeSub = term.onResize(({ cols, rows }) => handle.resize(cols, rows));
  handle.resize(term.cols, term.rows);
  handle.onExit((code) => term.write(`\r\n\x1b[90m[session ended: ${code}]\x1b[0m\r\n`));

  const onWinResize = () => fit.fit();
  window.addEventListener("resize", onWinResize);

  return () => {
    window.removeEventListener("resize", onWinResize);
    dataSub.dispose();
    resizeSub.dispose();
    handle.close();
    term.dispose();
  };
};

/** Convenience: a terminal block that renders with xterm.js out of the box. */
export const createXtermTerminalBlock = (opts: Omit<TerminalBlockOptions, "mount">) =>
  createTerminalBlock({ ...opts, mount: mountXterm });
