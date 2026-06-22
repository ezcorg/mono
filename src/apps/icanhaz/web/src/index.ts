import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { openTerminal } from "./client";

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node;
};

async function connect(): Promise<void> {
  const url = (el("url") as HTMLInputElement).value.trim();
  const pin = (el("pin") as HTMLInputElement).value.trim();
  const status = el("status");

  const term = new Terminal({
    fontFamily: "Menlo, Monaco, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: { background: "#1e1e1e" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el("term"));
  fit.fit();

  status.textContent = "connecting…";
  try {
    const handle = await openTerminal({
      url,
      pin,
      request: { jailed: false, cols: term.cols, rows: term.rows },
    });
    status.textContent = "connected";
    handle.onOutput((bytes) => term.write(bytes));
    term.onData((data) => handle.write(data));
    term.onResize(({ cols, rows }) => handle.resize(cols, rows));
    handle.onExit((code) => {
      term.write(`\r\n\x1b[90m[session ended: ${code}]\x1b[0m\r\n`);
      status.textContent = `ended (${code})`;
    });
    window.addEventListener("resize", () => fit.fit());
  } catch (e) {
    status.textContent = String(e);
    term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
  }
}

el("connect").addEventListener("click", () => {
  void connect();
});
