import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

// Mirrors the Rust `consent::CapabilityDto` (serde tag = "kind").
type FsRights = { read: boolean; write: boolean; create: boolean; delete: boolean; watch: boolean };
type PathGrant = { path: string; rights: FsRights };
type Capability =
  | { kind: "filesystem"; roots: PathGrant[] }
  | { kind: "process"; image: string; args: string[]; guest_chooses_argv: boolean }
  | { kind: "terminal"; shell: string | null; jailed: boolean }
  | { kind: "sockets"; endpoints: string[]; may_listen: boolean };
type Pending = { id: string; requester: string; summary: string; reason: string; capability: Capability };
// Mirror the Rust command DTOs.
type GrantView = { id: string; holder: string; summary: string; icon: string; expires_in_secs: number };
type CapabilityView = { id: string; icon: string; description: string };
type SiteView = { origin: string; kinds: string[] };

type Tab = "capabilities" | "grants" | "sites" | "hosts";
const TABS: [Tab, string][] = [
  ["capabilities", "Capabilities"],
  ["grants", "Grants"],
  ["sites", "Sites"],
  ["hosts", "Hosts"],
];

type FsCap = Extract<Capability, { kind: "filesystem" }>;
type ProcCap = Extract<Capability, { kind: "process" }>;
type TermCap = Extract<Capability, { kind: "terminal" }>;
type SockCap = Extract<Capability, { kind: "sockets" }>;

const RIGHTS: (keyof FsRights)[] = ["read", "write", "create", "delete", "watch"];
const TTLS: [string, number][] = [
  ["10 minutes", 600],
  ["1 hour", 3600],
  ["8 hours", 28800],
  ["1 day", 86400],
];

export function App() {
  const [pending, setPending] = createSignal<Pending[]>([]);
  const [grants, setGrants] = createSignal<GrantView[]>([]);
  const [caps, setCaps] = createSignal<CapabilityView[]>([]);
  const [sites, setSites] = createSignal<SiteView[]>([]);
  const [approvedHosts, setApprovedHosts] = createSignal<string[]>([]);
  const [unknownHosts, setUnknownHosts] = createSignal<SiteView[]>([]);
  const [tab, setTab] = createSignal<Tab>("grants");
  const [newHost, setNewHost] = createSignal("");

  const capIcon = (id: string) => caps().find((c) => c.id === id)?.icon ?? "🔑";

  const refresh = async () => {
    try {
      const [p, g, c, s, ah, uh] = await Promise.all([
        invoke<Pending[]>("list_pending"),
        invoke<GrantView[]>("list_grants"),
        invoke<CapabilityView[]>("list_capabilities", { lang: null }),
        invoke<SiteView[]>("list_pairings"),
        invoke<string[]>("list_hosts"),
        invoke<SiteView[]>("list_unknown_hosts"),
      ]);
      // Preserve object identity for pending ids so an in-progress card keeps its edits.
      setPending((prev) => {
        const byId = new Map(prev.map((x) => [x.id, x]));
        return p.map((f) => byId.get(f.id) ?? f);
      });
      setGrants(g);
      setCaps(c);
      setSites(s);
      setApprovedHosts(ah);
      setUnknownHosts(uh);
    } catch {
      /* transient — the backend may still be starting */
    }
  };

  const revoke = async (id: string) => {
    try {
      await invoke("revoke_grant", { id });
    } finally {
      refresh();
    }
  };
  const forget = async (origin: string) => {
    try {
      await invoke("forget_pairing", { origin });
    } finally {
      refresh();
    }
  };
  const addHost = async (origin?: string) => {
    const o = (origin ?? newHost()).trim();
    if (!o) return;
    await invoke("add_host", { origin: o });
    if (!origin) setNewHost("");
    refresh();
  };
  const removeHost = async (origin: string) => {
    await invoke("remove_host", { origin });
    refresh();
  };

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <main class="wrap">
      <style>{CSS}</style>
      <h1>icanhaz <span class="dim">— consent</span></h1>

      {/* Pending requests stay pinned at the top when present — they're time-sensitive. */}
      <Show when={pending().length > 0}>
        <p class="dim intro">// approve only what you recognise, narrowed to just the access it needs</p>
        <For each={pending()}>{(req) => <RequestCard req={req} onResolved={refresh} />}</For>
      </Show>

      <nav class="tabs">
        <For each={TABS}>
          {([id, label]) => (
            <button class="tab" classList={{ active: tab() === id }} onClick={() => setTab(id)}>
              {label}
            </button>
          )}
        </For>
      </nav>

      <Show when={tab() === "capabilities"}>
        <p class="dim intro">// capabilities installed on this host</p>
        <For each={caps()} fallback={<p class="empty">No capabilities installed.</p>}>
          {(c) => (
            <div class="row">
              <span class="ico">{c.icon}</span>
              <div class="grow">
                <div class="row-title">{c.id}</div>
                <div class="desc dim">{c.description}</div>
              </div>
            </div>
          )}
        </For>
      </Show>

      <Show when={tab() === "grants"}>
        <For each={grants()} fallback={<p class="empty">No active grants.</p>}>
          {(g) => (
            <div class="row">
              <span class="ico">{g.icon}</span>
              <div class="grow">
                <span class="chip">{g.summary}</span> <span class="dim">{g.holder}</span>
              </div>
              <div class="row-meta">
                <span class="dim">{fmtDur(g.expires_in_secs)}</span>
                <button class="mini danger" onClick={() => revoke(g.id)}>revoke</button>
              </div>
            </div>
          )}
        </For>
      </Show>

      <Show when={tab() === "sites"}>
        <p class="dim intro">// sites you chose to remember. Revoking a grant also forgets its site.</p>
        <For each={sites()} fallback={<p class="empty">No remembered sites.</p>}>
          {(s) => (
            <div class="row">
              <div class="grow">
                <b>{s.origin}</b>{" "}
                <span class="kinds">
                  <For each={s.kinds}>{(k) => <span title={k}>{capIcon(k)}</span>}</For>
                </span>
              </div>
              <button class="mini danger" onClick={() => forget(s.origin)}>forget</button>
            </div>
          )}
        </For>
      </Show>

      <Show when={tab() === "hosts"}>
        <p class="dim intro">// only approved hosts may request. Others are recorded below (no notification) for you to approve.</p>

        <Show when={unknownHosts().length > 0}>
          <div class="section-label">requested access</div>
          <For each={unknownHosts()}>
            {(u) => (
              <div class="row">
                <div class="grow">
                  <b>{u.origin}</b>{" "}
                  <span class="kinds"><For each={u.kinds}>{(k) => <span title={k}>{capIcon(k)}</span>}</For></span>
                </div>
                <button class="mini" onClick={() => addHost(u.origin)}>approve</button>
              </div>
            )}
          </For>
        </Show>

        <div class="section-label">approved hosts</div>
        <div class="add-host">
          <input
            placeholder="https://example.com"
            value={newHost()}
            onInput={(e) => setNewHost(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && addHost()}
          />
          <button class="mini" onClick={() => addHost()}>add</button>
        </div>
        <For each={approvedHosts()} fallback={<p class="empty">No approved hosts.</p>}>
          {(o) => (
            <div class="row">
              <b class="grow">{o}</b>
              <button class="mini danger" onClick={() => removeHost(o)}>remove</button>
            </div>
          )}
        </For>
      </Show>
    </main>
  );
}

function fmtDur(secs: number): string {
  if (secs >= 86400) return `${Math.round(secs / 86400)}d`;
  if (secs >= 3600) return `${Math.round(secs / 3600)}h`;
  if (secs >= 60) return `${Math.round(secs / 60)}m`;
  return `${secs}s`;
}

function RequestCard(props: { req: Pending; onResolved: () => void }) {
  // An editable copy of the requested capability — the human narrows this in place.
  const [cap, setCap] = createSignal<Capability>(structuredClone(props.req.capability));
  const [ttl, setTtl] = createSignal(3600);
  const [remember, setRemember] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      // Send the narrowed capability; the broker clamps it to a subset of the request.
      await invoke("decide", { id: props.req.id, allow, grant: allow ? cap() : null, remember: remember(), ttlSecs: ttl() });
    } finally {
      setBusy(false);
      props.onResolved();
    }
  };

  return (
    <div class="card">
      <div class="who">
        <b>{props.req.requester}</b> <span class="dim">wants</span> <span class="chip">{props.req.summary}</span>
      </div>
      <Show when={props.req.reason}>
        <div class="reason">{props.req.reason}</div>
      </Show>
      <CapabilityEditor orig={props.req.capability} cap={cap} setCap={setCap} />
      <div class="controls">
        <label>
          expires{" "}
          <select onChange={(e) => setTtl(+e.currentTarget.value)}>
            <For each={TTLS}>{([label, secs]) => <option value={secs} selected={secs === 3600}>{label}</option>}</For>
          </select>
        </label>
        <label class="rem">
          <input type="checkbox" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} /> remember
          this site
        </label>
      </div>
      <div class="actions">
        <button class="approve" disabled={busy()} onClick={() => decide(true)}>
          Approve
        </button>
        <button class="deny" disabled={busy()} onClick={() => decide(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

function CapabilityEditor(props: { orig: Capability; cap: () => Capability; setCap: (c: Capability) => void }) {
  const fs = () => props.cap() as FsCap;
  const proc = () => props.cap() as ProcCap;
  const term = () => props.cap() as TermCap;
  const sock = () => props.cap() as SockCap;

  const setRight = (i: number, key: keyof FsRights, val: boolean) => {
    const c = props.cap();
    if (c.kind !== "filesystem") return;
    props.setCap({ ...c, roots: c.roots.map((r, idx) => (idx === i ? { ...r, rights: { ...r.rights, [key]: val } } : r)) });
  };
  const setArgv = (val: boolean) => {
    const c = props.cap();
    if (c.kind === "process") props.setCap({ ...c, guest_chooses_argv: val });
  };
  const setJailed = (val: boolean) => {
    const c = props.cap();
    if (c.kind === "terminal") props.setCap({ ...c, jailed: val });
  };
  const rootActive = (r: PathGrant) => RIGHTS.some((k) => r.rights[k]);

  return (
    <div class="cap">
      <Show when={props.cap().kind === "filesystem"}>
        <div class="cap-title">filesystem — untick to narrow, clear a row to exclude it</div>
        <For each={fs().roots}>
          {(r, i) => (
            <div class="root" classList={{ excluded: !rootActive(r) }}>
              <span class="path">{r.path}</span>
              <span class="rightset">
                <For each={RIGHTS}>
                  {(key) => (
                    <label class="right">
                      <input type="checkbox" checked={r.rights[key]} onChange={(e) => setRight(i(), key, e.currentTarget.checked)} />
                      {key}
                    </label>
                  )}
                </For>
              </span>
            </div>
          )}
        </For>
      </Show>

      <Show when={props.cap().kind === "process"}>
        <div class="cap-title">run program</div>
        <code class="cmd">
          <span class="prompt">$ </span>
          {proc().image}
          {proc().args.length ? " " + proc().args.join(" ") : ""}
        </code>
        <label class="toggle" classList={{ disabled: !(props.orig as ProcCap).guest_chooses_argv }}>
          <input
            type="checkbox"
            checked={proc().guest_chooses_argv}
            disabled={!(props.orig as ProcCap).guest_chooses_argv}
            onChange={(e) => setArgv(e.currentTarget.checked)}
          />
          let the site change these arguments
        </label>
      </Show>

      <Show when={props.cap().kind === "terminal"}>
        <div class="cap-title">terminal — {term().jailed ? "sandboxed shell" : "your login shell"}</div>
        <Show when={term().shell}>{(s) => <code class="cmd"><span class="prompt">$ </span>{s()}</code>}</Show>
        <label class="toggle" classList={{ disabled: (props.orig as TermCap).jailed }}>
          <input
            type="checkbox"
            checked={term().jailed}
            disabled={(props.orig as TermCap).jailed}
            onChange={(e) => setJailed(e.currentTarget.checked)}
          />
          sandbox the shell (jailed)
        </label>
      </Show>

      <Show when={props.cap().kind === "sockets"}>
        <div class="cap-title">network{sock().may_listen ? " — may listen" : ""}</div>
        <For each={sock().endpoints}>{(e) => <div class="root"><span class="path">{e}</span></div>}</For>
      </Show>
    </div>
  );
}

const CSS = `
:root {
  color-scheme: light dark;
  --fg: CanvasText;
  --bg: Canvas;
  --accent: #3fb950;
  --danger: #f85149;
  --border: color-mix(in srgb, CanvasText 22%, transparent);
  --panel: color-mix(in srgb, CanvasText 5%, Canvas);
  --inset: color-mix(in srgb, CanvasText 9%, transparent);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); }
.wrap { font: 13px/1.55 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; max-width: 42rem; margin: 0 auto; padding: 1.25rem 1.1rem; color: var(--fg); }
h1 { font-size: .95rem; margin: 0 0 .8rem; font-weight: 700; }
.dim { opacity: .55; font-weight: 400; }
.intro { margin: .1rem 0 1rem; }
.empty { opacity: .55; border: 1px dashed var(--border); border-radius: 8px; padding: 1rem; }
.card { border: 1px solid var(--border); border-radius: 8px; padding: .85rem .9rem; margin: .7rem 0; background: var(--panel); }
.who b { font-weight: 700; }
.chip { background: var(--inset); padding: .05rem .4rem; border-radius: 4px; }
.reason { opacity: .8; margin: .45rem 0; border-left: 2px solid var(--border); padding-left: .6rem; }
.cap { margin: .55rem 0; }
.cap-title { opacity: .55; font-size: .8em; text-transform: uppercase; letter-spacing: .06em; margin-bottom: .4rem; }
.cmd { display: block; background: var(--inset); padding: .4rem .55rem; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
.cmd .prompt { opacity: .45; }
.root { display: flex; gap: .55rem; align-items: baseline; flex-wrap: wrap; padding: .2rem 0; }
.root.excluded { opacity: .4; text-decoration: line-through; }
.path { background: var(--inset); padding: 0 .3rem; border-radius: 4px; }
.rightset { display: inline-flex; gap: .55rem; flex-wrap: wrap; }
.right { display: inline-flex; align-items: center; gap: .22rem; font-size: .85em; opacity: .9; cursor: pointer; }
.right input, .rem input, .toggle input { accent-color: var(--accent); }
.toggle { display: flex; align-items: center; gap: .4rem; margin-top: .45rem; font-size: .9em; cursor: pointer; }
.toggle.disabled { opacity: .5; cursor: default; }
.controls { display: flex; gap: 1.1rem; align-items: center; margin: .75rem 0 .6rem; flex-wrap: wrap; font-size: .9em; }
select { font: inherit; padding: .2rem .3rem; border-radius: 6px; border: 1px solid var(--border); background: var(--panel); color: inherit; }
.rem { display: inline-flex; align-items: center; gap: .3rem; }
.actions { display: flex; gap: .5rem; }
button { font: inherit; padding: .35rem 1rem; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; background: var(--panel); color: inherit; }
button:disabled { opacity: .5; cursor: default; }
.approve { background: var(--accent); color: #06130a; border-color: transparent; font-weight: 700; }
.deny:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
.tabs { display: flex; gap: .1rem; border-bottom: 1px solid var(--border); margin: 1.3rem 0 .8rem; }
.tab { font: inherit; background: none; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: .35rem .65rem; opacity: .5; cursor: pointer; color: inherit; }
.tab:hover:not(:disabled) { opacity: .8; }
.tab.active { opacity: 1; border-bottom-color: var(--accent); font-weight: 700; }
.row { display: flex; align-items: center; gap: .6rem; border: 1px solid var(--border); border-radius: 8px; padding: .5rem .7rem; margin: .4rem 0; background: var(--panel); }
.ico { font-size: 1.1rem; line-height: 1; flex: none; }
.grow { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.row-title { font-weight: 700; }
.desc { font-size: .88em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.row-meta { display: inline-flex; align-items: center; gap: .7rem; font-size: .88em; flex: none; }
.mini { padding: .2rem .75rem; font-size: .85em; }
.mini.danger:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
.kinds { display: inline-flex; gap: .25rem; }
.section-label { font-size: .72rem; text-transform: uppercase; letter-spacing: .07em; opacity: .5; margin: 1rem 0 .3rem; font-weight: 700; }
.add-host { display: flex; gap: .5rem; margin: .5rem 0; }
.add-host input { flex: 1; min-width: 0; font: inherit; padding: .35rem .5rem; border-radius: 6px; border: 1px solid var(--border); background: var(--panel); color: inherit; }
`;
