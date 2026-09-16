import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

// Mirrors the Rust `consent::CapabilityDto` (serde tag = "kind").
type FsRights = { read: boolean; write: boolean; create: boolean; delete: boolean; watch: boolean };
type PathGrant = { path: string; rights: FsRights };
type Capability =
  | { kind: "filesystem"; roots: PathGrant[] }
  | { kind: "process"; image: string; args: string[]; guest_chooses_argv: boolean }
  | { kind: "terminal"; shell: string | null; jailed: boolean }
  | { kind: "sockets"; endpoints: string[]; may_listen: boolean }
  | { kind: "inference"; models: string[] }
  | { kind: "foreign"; path: string; summary: string };
type ScopeText = { when: string[]; allow: string[] };
type Pending = {
  id: string;
  requester: string;
  summary: string;
  reason: string;
  capability: Capability;
  scope: { when: string; allow: string };
  text: ScopeText;
};
// Mirror the Rust command DTOs.
type GrantView = { id: string; holder: string; summary: string; icon: string; expires_in_secs: number };
type CapabilityView = { id: string; icon: string; description: string };
// Mirrors `icanhaz_host::configuration` (ezco:ezcap/forms as JSON): a unit input
// type is its name, `select` carries its options; values are externally tagged.
type InputType = "str" | "boolean" | "number" | "datetime" | "daterange" | "file" | "binary" | "secret" | { select: string[] };
type Value =
  | { str: string }
  | { boolean: boolean }
  | { number: number }
  | { select: string }
  | { datetime: string }
  | { daterange: [string, string] }
  | { secret: string };
type Field = { name: string; input_type: InputType; optional: boolean; default: Value | null; description: string | null };
type Configured = { name: string; value: Value | null; set: boolean };
type Instance = { name: string; owner: string; values: Configured[] };
type ConfigurationView = {
  capability: string;
  instance_noun: string;
  owner_prefix: string;
  fields: Field[];
  icon: string;
  instances: Instance[];
  writable: boolean;
};
type SiteView = { origin: string; kinds: string[] };

type ErrorEntry = { id: number; message: string };
type AppInfo = { version: string; ws: string; wt: string; root: string };

type Tab = "capabilities" | "grants" | "sites" | "hosts" | "settings";
const TABS: [Tab, string][] = [
  ["capabilities", "Capabilities"],
  ["grants", "Grants"],
  ["sites", "Sites"],
  ["hosts", "Hosts"],
  ["settings", "Settings"],
];

// A persisted default grant lifetime (Settings) used to seed the consent dropdown.
const TTL_KEY = "icanhaz.defaultTtlSecs";
const defaultTtl = () => Number(localStorage.getItem(TTL_KEY)) || 3600;

type FsCap = Extract<Capability, { kind: "filesystem" }>;
type ProcCap = Extract<Capability, { kind: "process" }>;
type TermCap = Extract<Capability, { kind: "terminal" }>;
type SockCap = Extract<Capability, { kind: "sockets" }>;
type InfCap = Extract<Capability, { kind: "inference" }>;

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
  const [config, setConfig] = createSignal<ConfigurationView[]>([]);
  const [sites, setSites] = createSignal<SiteView[]>([]);
  const [approvedHosts, setApprovedHosts] = createSignal<string[]>([]);
  const [unknownHosts, setUnknownHosts] = createSignal<SiteView[]>([]);
  const [errors, setErrors] = createSignal<ErrorEntry[]>([]);
  const [info, setInfo] = createSignal<AppInfo | null>(null);
  const [ttl, setTtl] = createSignal(defaultTtl());
  const [tab, setTab] = createSignal<Tab>("grants");
  const [newHost, setNewHost] = createSignal("");

  const capIcon = (id: string) => caps().find((c) => c.id === id)?.icon ?? "🔑";

  const refresh = async () => {
    try {
      const [p, g, c, s, ah, uh, er, cf] = await Promise.all([
        invoke<Pending[]>("list_pending"),
        invoke<GrantView[]>("list_grants"),
        invoke<CapabilityView[]>("list_capabilities", { lang: null }),
        invoke<SiteView[]>("list_pairings"),
        invoke<string[]>("list_hosts"),
        invoke<SiteView[]>("list_unknown_hosts"),
        invoke<ErrorEntry[]>("list_errors"),
        invoke<ConfigurationView[]>("list_configuration"),
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
      setErrors(er);
      // Keep a panel's rows stable while its form is open: replace only on change.
      setConfig((prev) => (JSON.stringify(prev) === JSON.stringify(cf) ? prev : cf));
    } catch {
      /* transient — the backend may still be starting */
    }
  };

  const dismissError = async (id: number) => {
    await invoke("dismiss_error", { id });
    refresh();
  };
  const clearPairings = async () => {
    await invoke("clear_pairings");
    refresh();
  };
  const clearHosts = async () => {
    await invoke("clear_hosts");
    refresh();
  };
  const setDefaultTtl = (secs: number) => {
    setTtl(secs);
    localStorage.setItem(TTL_KEY, String(secs));
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
    invoke<AppInfo>("app_info").then(setInfo).catch(() => {});
    const timer = setInterval(refresh, 1000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <main class="wrap">
      <style>{CSS}</style>
      <h1>icanhaz <span class="dim">— consent</span></h1>

      {/* Backend errors (e.g. the daemon failing to bind a port) surface here. */}
      <For each={errors()}>
        {(e) => (
          <div class="err">
            <span class="grow">{e.message}</span>
            <button class="err-x" onClick={() => dismissError(e.id)} title="dismiss">×</button>
          </div>
        )}
      </For>

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
        <p class="dim intro">// capabilities installed on this host. Those that need setup take it here; keys never leave this machine.</p>
        <For each={caps()} fallback={<p class="empty">No capabilities installed.</p>}>
          {(c) => (
            <>
              <div class="row">
                <span class="ico">{c.icon}</span>
                <div class="grow">
                  <div class="row-title">{c.id}</div>
                  <div class="desc dim">{c.description}</div>
                </div>
              </div>
              <Show when={config().find((cfg) => cfg.capability === c.id)}>
                {(cfg) => <ConfigurationPanel cfg={cfg()} onChanged={refresh} />}
              </Show>
            </>
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

      <Show when={tab() === "settings"}>
        <div class="section-label">default grant lifetime</div>
        <div class="row">
          <span class="grow dim">new approvals start at this expiry</span>
          <select value={ttl()} onChange={(e) => setDefaultTtl(+e.currentTarget.value)}>
            <For each={TTLS}>{([label, secs]) => <option value={secs} selected={secs === ttl()}>{label}</option>}</For>
          </select>
        </div>

        <div class="section-label">stored trust</div>
        <div class="row">
          <span class="grow">Remembered sites</span>
          <button class="mini danger" onClick={clearPairings}>forget all</button>
        </div>
        <div class="row">
          <span class="grow">Approved hosts</span>
          <button class="mini danger" onClick={clearHosts}>clear all</button>
        </div>

        <div class="section-label">about</div>
        <Show when={info()}>
          {(i) => (
            <div class="about">
              <div><span class="dim">version</span> {i().version}</div>
              <div><span class="dim">websocket</span> <code>ws://{i().ws}</code></div>
              <div><span class="dim">webtransport</span> <code>https://{i().wt}</code></div>
              <div><span class="dim">jail root</span> <code>{i().root}</code></div>
            </div>
          )}
        </Show>
      </Show>
    </main>
  );
}

// One declared configuration: its configured instances as rows, and a form
// (generated from the `forms` schema) to add one or edit one in place.
function ConfigurationPanel(props: { cfg: ConfigurationView; onChanged: () => void }) {
  type Draft = Record<string, string | boolean>;
  const [editing, setEditing] = createSignal<string | null>(null); // instance name, "" = new
  const [name, setName] = createSignal("");
  const [draft, setDraft] = createSignal<Draft>({});
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const isSelect = (t: InputType): t is { select: string[] } => typeof t === "object" && "select" in t;
  const text = (v: Value | null): string => {
    if (!v) return "";
    if ("str" in v) return v.str;
    if ("select" in v) return v.select;
    if ("datetime" in v) return v.datetime;
    if ("number" in v) return String(v.number);
    if ("boolean" in v) return v.boolean ? "yes" : "no";
    return "";
  };
  const blank = (): Draft => {
    const d: Draft = {};
    for (const f of props.cfg.fields) {
      if (f.input_type === "boolean") d[f.name] = f.default && "boolean" in f.default ? f.default.boolean : false;
      else if (isSelect(f.input_type)) d[f.name] = text(f.default) || f.input_type.select[0] || "";
      else d[f.name] = f.input_type === "secret" ? "" : text(f.default);
    }
    return d;
  };
  const open = (inst: Instance | null) => {
    setError(null);
    setName(inst?.name ?? "");
    const d = blank();
    for (const v of inst?.values ?? []) {
      const f = props.cfg.fields.find((f) => f.name === v.name);
      if (!f || f.input_type === "secret") continue;
      d[v.name] = f.input_type === "boolean" ? (v.value && "boolean" in v.value ? v.value.boolean : false) : text(v.value);
    }
    setDraft(d);
    setEditing(inst?.name ?? "");
  };
  const secretSet = (field: string) =>
    props.cfg.instances.find((i) => i.name === editing())?.values.find((v) => v.name === field)?.set ?? false;
  const value = (f: Field): Value | null => {
    const raw = draft()[f.name];
    if (f.input_type === "boolean") return { boolean: raw === true };
    const s = typeof raw === "string" ? raw.trim() : "";
    if (isSelect(f.input_type)) return { select: s };
    if (f.input_type === "number") return s === "" ? null : { number: Number(s) };
    if (f.input_type === "secret") return { secret: s }; // blank keeps the stored secret
    if (f.input_type === "datetime") return { datetime: s };
    return { str: s };
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const inputs = props.cfg.fields
        .map((f) => ({ name: f.name, value: value(f) }))
        .filter((i): i is { name: string; value: Value } => i.value !== null);
      await invoke("set_configuration", { capability: props.cfg.capability, instance: name(), inputs });
      setEditing(null);
      props.onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (instance: string) => {
    if (!confirm(`Remove ${props.cfg.instance_noun} "${instance}"?`)) return;
    try {
      await invoke("remove_configuration", { capability: props.cfg.capability, instance });
      if (editing() === instance) setEditing(null);
      props.onChanged();
    } catch (e) {
      setError(String(e));
    }
  };
  const summary = (inst: Instance) =>
    inst.values
      .filter((v) => v.value !== null && !(v.value && "boolean" in v.value) && text(v.value) !== "")
      .map((v) => text(v.value))
      .join(" · ");

  return (
    <div class="config">
      <div class="config-head">
        <span class="section-label">{props.cfg.instance_noun}s</span>
        <Show when={props.cfg.writable} fallback={<span class="dim">store unavailable — read-only</span>}>
          <button class="mini" disabled={editing() === ""} onClick={() => open(null)}>
            add {props.cfg.instance_noun}
          </button>
        </Show>
      </div>
      <For each={props.cfg.instances} fallback={<p class="empty small">No {props.cfg.instance_noun} configured.</p>}>
        {(inst) => (
          <div class="row sub" classList={{ active: editing() === inst.name }}>
            <div class="grow">
              <b>{inst.name}</b> <span class="dim">{summary(inst)}</span>
            </div>
            <div class="row-meta">
              <button class="mini" disabled={!props.cfg.writable} onClick={() => open(inst)}>edit</button>
              <button class="mini danger" disabled={!props.cfg.writable} onClick={() => remove(inst.name)}>remove</button>
            </div>
          </div>
        )}
      </For>
      <Show when={editing() !== null}>
        <form class="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label class="field">
            <span class="field-name">name</span>
            <input
              id={`cfg-${props.cfg.capability}-name`}
              value={name()}
              disabled={editing() !== ""}
              placeholder={`e.g. local`}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <span class="field-desc dim">how this {props.cfg.instance_noun} is referred to here</span>
          </label>
          <For each={props.cfg.fields}>
            {(f) => (
              <label class="field" classList={{ check: f.input_type === "boolean" }}>
                <span class="field-name">{f.name}{f.optional ? <span class="dim"> (optional)</span> : ""}</span>
                <Show when={isSelect(f.input_type)}>
                  <select
                    id={`cfg-${props.cfg.capability}-${f.name}`}
                    value={String(draft()[f.name] ?? "")}
                    onChange={(e) => setDraft({ ...draft(), [f.name]: e.currentTarget.value })}
                  >
                    <For each={isSelect(f.input_type) ? f.input_type.select : []}>
                      {(o) => <option value={o} selected={draft()[f.name] === o}>{o}</option>}
                    </For>
                  </select>
                </Show>
                <Show when={f.input_type === "boolean"}>
                  <input
                    id={`cfg-${props.cfg.capability}-${f.name}`}
                    type="checkbox"
                    checked={draft()[f.name] === true}
                    onChange={(e) => setDraft({ ...draft(), [f.name]: e.currentTarget.checked })}
                  />
                </Show>
                <Show when={!isSelect(f.input_type) && f.input_type !== "boolean"}>
                  <input
                    id={`cfg-${props.cfg.capability}-${f.name}`}
                    type={f.input_type === "secret" ? "password" : f.input_type === "number" ? "number" : "text"}
                    autocomplete={f.input_type === "secret" ? "off" : undefined}
                    value={String(draft()[f.name] ?? "")}
                    placeholder={f.input_type === "secret" && secretSet(f.name) ? "unchanged — leave blank to keep" : ""}
                    onInput={(e) => setDraft({ ...draft(), [f.name]: e.currentTarget.value })}
                  />
                </Show>
                <Show when={f.description}>{(d) => <span class="field-desc dim">{d()}</span>}</Show>
              </label>
            )}
          </For>
          <Show when={error()}>{(e) => <div class="form-err">{e()}</div>}</Show>
          <div class="actions">
            <button type="submit" class="approve" disabled={busy()}>
              {editing() === "" ? "Add" : "Save"}
            </button>
            <button type="button" disabled={busy()} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      </Show>
    </div>
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
  const [ttl, setTtl] = createSignal(defaultTtl());
  const [remember, setRemember] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // An extra `allow` clause the human appends; checked live against the kind's
  // interface, and shown back as sentences before it is applied.
  const [extra, setExtra] = createSignal("");
  const [extraText, setExtraText] = createSignal<ScopeText | null>(null);
  const [extraError, setExtraError] = createSignal<string | null>(null);
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  const check = (allow: string) => {
    clearTimeout(checkTimer);
    if (!allow.trim()) {
      setExtraText(null);
      setExtraError(null);
      return;
    }
    checkTimer = setTimeout(async () => {
      try {
        setExtraText(await invoke<ScopeText>("check_narrowing", { id: props.req.id, narrowing: { allow } }));
        setExtraError(null);
      } catch (e) {
        setExtraText(null);
        setExtraError(String(e));
      }
    }, 250);
  };
  onCleanup(() => clearTimeout(checkTimer));
  const restricted = () => props.req.text.when.length + props.req.text.allow.length > 0;
  const shown = () => extraText() ?? props.req.text;

  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      // Send the narrowed capability and clauses; the broker clamps the former
      // to a subset of the request and conjoins the latter onto its scope.
      await invoke("decide", {
        id: props.req.id,
        allow,
        grant: allow ? cap() : null,
        narrowing: allow && extra().trim() ? { allow: extra() } : null,
        remember: remember(),
        ttlSecs: ttl(),
      });
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
      <div class="cap scope">
        <div class="cap-title">{restricted() || extra().trim() ? "only" : "no further limits proposed"}</div>
        <Show when={shown().when.length > 0}>
          <ul class="sentences" title={props.req.scope.when}>
            <For each={shown().when}>{(t) => <li><span class="dim">when </span>{t}</li>}</For>
          </ul>
        </Show>
        <Show when={shown().allow.length > 0}>
          <ul class="sentences" title={props.req.scope.allow}>
            <For each={shown().allow}>{(t) => <li>{t}</li>}</For>
          </ul>
        </Show>
        <input
          id={`narrow-${props.req.id}`}
          class="narrow"
          classList={{ bad: !!extraError() }}
          placeholder="add a limit, e.g. state.tokens < 20000"
          value={extra()}
          onInput={(e) => { setExtra(e.currentTarget.value); check(e.currentTarget.value); }}
        />
        <Show when={extraError()}>{(e) => <div class="form-err">{e()}</div>}</Show>
      </div>
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
        <button class="approve" disabled={busy() || !!extraError()} onClick={() => decide(true)}>
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

      <Show when={props.cap().kind === "foreign"}>
        <div class="cap-title">on behalf of another host</div>
        <div class="root">
          <span class="path">{(props.cap() as Extract<Capability, { kind: "foreign" }>).path}</span>
        </div>
        <div class="dim">{(props.cap() as Extract<Capability, { kind: "foreign" }>).summary}</div>
      </Show>

      <Show when={props.cap().kind === "inference"}>
        <div class="cap-title">language model</div>
        <Show
          when={(props.cap() as InfCap).models.length > 0}
          fallback={<div class="root"><span class="path">any configured model</span></div>}
        >
          <For each={(props.cap() as InfCap).models}>{(m) => <div class="root"><span class="path">{m}</span></div>}</For>
        </Show>
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
.scope { border-top: 1px dashed var(--border); padding-top: .5rem; }
.sentences { margin: 0 0 .4rem; padding-left: 1.1rem; }
.sentences li { padding: .05rem 0; }
.narrow { width: 100%; font: inherit; padding: .3rem .45rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: inherit; }
.narrow.bad { border-color: var(--danger); }
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
.err { display: flex; align-items: center; gap: .6rem; border: 1px solid var(--danger); border-radius: 8px; padding: .5rem .7rem; margin: .5rem 0; background: color-mix(in srgb, var(--danger) 12%, transparent); }
.err-x { font: inherit; background: none; border: none; color: inherit; cursor: pointer; font-size: 1.1rem; line-height: 1; padding: 0 .2rem; opacity: .7; }
.err-x:hover { opacity: 1; }
.about { font-size: .9em; }
.about > div { padding: .12rem 0; overflow-wrap: anywhere; }
.about .dim { display: inline-block; min-width: 6.5rem; }
.config { margin: -.1rem 0 .9rem .9rem; padding-left: .8rem; border-left: 2px solid var(--border); }
.config-head { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
.config-head .section-label { margin: .4rem 0 .2rem; }
.row.sub { padding: .35rem .6rem; margin: .3rem 0; }
.row.sub.active { border-color: var(--accent); }
.empty.small { padding: .5rem .7rem; margin: .3rem 0; font-size: .9em; }
.form { display: flex; flex-direction: column; gap: .55rem; border: 1px solid var(--border); border-radius: 8px; padding: .7rem .8rem; margin: .4rem 0; background: var(--panel); }
.field { display: grid; grid-template-columns: 7rem 1fr; gap: .15rem .6rem; align-items: center; }
.field.check { grid-template-columns: 7rem auto; justify-content: start; }
.field-name { font-weight: 700; }
.field-desc { grid-column: 2; font-size: .85em; }
.field input:not([type=checkbox]), .field select { width: 100%; font: inherit; padding: .3rem .45rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: inherit; }
.field input[type=checkbox] { accent-color: var(--accent); justify-self: start; }
.form-err { color: var(--danger); font-size: .9em; }
.form .actions { margin-top: .2rem; }
@media (max-width: 30rem) { .field, .field.check { grid-template-columns: 1fr; } .field-desc { grid-column: 1; } }
.add-host { display: flex; gap: .5rem; margin: .5rem 0; }
.add-host input { flex: 1; min-width: 0; font: inherit; padding: .35rem .5rem; border-radius: 6px; border: 1px solid var(--border); background: var(--panel); color: inherit; }
`;
