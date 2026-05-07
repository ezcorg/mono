import {
  createSignal,
  createEffect,
  onCleanup,
  untrack,
  Show,
  Switch as SolidSwitch,
  Match,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Cloud,
  Server,
  ArrowRight,
  ArrowLeft,
  LogIn,
  UserPlus,
  Check,
  Globe,
  X,
  Loader2,
  Monitor,
  ExternalLink,
  Download,
  FolderOpen,
  ShieldCheck,
  HardDrive,
  Sparkles,
  Link as LinkIcon,
} from "lucide-solid";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import { RadioGroup } from "../components/ui/radio-group";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../components/ui/card";
import { DayNightScene } from "../components/day-night-scene";
import { EzfilterLogo } from "../components/ezfilter-logo";
import { setConfig, getConfig, type HostingMode } from "../lib/stores/config";
import { api } from "../lib/api/client";
import { setToken, setTenantId, setEmail as storeEmail } from "../lib/stores/auth";
import { t } from "../lib/i18n";

type Step =
  | "connect-or-create"
  | "hosting"
  | "has-server"
  | "server-url"
  | "local-setup"
  | "remote-info"
  | "login"
  | "signup";

type HealthStatus = "idle" | "checking" | "ok" | "error" | "tls-error";

type BinaryStatus = "unknown" | "checking" | "found" | "not-found";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useDebounce<T>(value: () => T, delayMs: number): () => T {
  const [debounced, setDebounced] = createSignal<T>(value());
  let timer: ReturnType<typeof setTimeout>;

  createEffect(() => {
    const v = value();
    clearTimeout(timer);
    timer = setTimeout(() => setDebounced(() => v), delayMs);
  });

  onCleanup(() => clearTimeout(timer));
  return debounced;
}

/** Check /api/health and distinguish TLS from other errors. */
async function checkHealth(
  baseUrl: string
): Promise<{ status: HealthStatus; message?: string }> {
  if (!baseUrl.trim()) return { status: "idle" };

  // Validate that it's an absolute URL with a real protocol
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { status: "error", message: t("error_invalid_url_protocol") };
    }
  } catch {
    return { status: "error", message: t("error_invalid_url") };
  }

  try {
    const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/health`;
    const res = await fetch(url);
    if (res.ok) return { status: "ok" };
    return {
      status: "error",
      message: t("error_server_status", res.status, res.statusText),
    };
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    // Browsers surface TLS failures as TypeErrors with messages containing
    // keywords like "SSL", "certificate", "CERT", or "ERR_CERT".
    if (/ssl|certificate|cert|tls|ERR_CERT/i.test(msg)) {
      return {
        status: "tls-error",
        message: t("error_tls"),
      };
    }
    return {
      status: "error",
      message: t("error_server_unreachable"),
    };
  }
}

/** Try to detect the `witm` binary on the local system via Tauri invoke. */
async function detectBinary(): Promise<{
  found: boolean;
  path?: string;
}> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<{ found: boolean; path?: string }>(
      "check_binary",
      { name: "witm" }
    );
  } catch {
    // Not running inside Tauri — can't check PATH from the browser
    return { found: false };
  }
}

/** Open a file picker to manually select the witm binary. */
async function pickBinaryFile(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: t("setup_local_select_binary"),
      multiple: false,
      filters: [{ name: "Executable", extensions: ["*"] }],
    });
    if (selected) return typeof selected === "string" ? selected : selected.path;
  } catch {
    // Not running in Tauri
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SetupPage() {
  const navigate = useNavigate();

  // -- wizard state --
  const [step, setStep] = createSignal<Step>("connect-or-create");
  const [hostingMode, setHostingMode] = createSignal<HostingMode>("managed");
  const [serverUrl, setServerUrl] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  // -- health check state --
  const [healthStatus, setHealthStatus] = createSignal<HealthStatus>("idle");
  const [healthMessage, setHealthMessage] = createSignal("");

  // -- local setup state --
  const [binaryStatus, setBinaryStatus] =
    createSignal<BinaryStatus>("unknown");
  const [binaryPath, setBinaryPath] = createSignal("");
  type StepState = "idle" | "checking" | "done" | "needed" | "error";
  const [serviceState, setServiceState] = createSignal<StepState>("idle");
  const [caState, setCaState] = createSignal<StepState>("idle");
  const [proxyState, setProxyState] = createSignal<StepState>("idle");
  const [stepMessage, setStepMessage] = createSignal("");
  const allStepsDone = () =>
    serviceState() === "done" && caState() === "done" && proxyState() === "done";

  const API_VERSION = "v1";
  const MANAGED_BASE = "https://ezfilter.joinez.co";
  const DOCS_URL = "https://docs.ezfilter.joinez.co/self-host";
  const DOWNLOAD_URL = "https://github.com/ezcorg/mono/releases?q=witmproxy";

  // -- debounced server URL for health check --
  const debouncedUrl = useDebounce(() => serverUrl(), 500);

  // React to debounced URL changes and run the health check
  createEffect(() => {
    const url = debouncedUrl();
    if (!url.trim()) {
      setHealthStatus("idle");
      setHealthMessage("");
      return;
    }
    setHealthStatus("checking");
    setHealthMessage("");

    checkHealth(url).then(({ status, message }) => {
      // Only apply if the URL hasn't changed since we started
      if (debouncedUrl() === url) {
        setHealthStatus(status);
        setHealthMessage(message ?? "");
      }
    });
  });

  // -- derived helpers --

  function getEffectiveUrl(): string {
    if (hostingMode() === "managed") {
      return `${MANAGED_BASE}/api/${API_VERSION}`;
    }
    return serverUrl().replace(/\/+$/, "");
  }

  function goNext() {
    setError("");
    const current = step();
    if (current === "hosting") {
      if (hostingMode() === "self-host") {
        setStep("has-server");
      } else {
        setStep("login");
      }
    } else if (current === "has-server") {
      // handled by button callbacks
    } else if (current === "server-url") {
      if (!serverUrl().trim()) {
        setError(t("setup_server_enter_url"));
        return;
      }
      if (healthStatus() !== "ok") {
        setError(healthStatus() === "checking" ? t("setup_server_wait_health") : t("error_server_unreachable"));
        return;
      }
      setStep("login");
    } else if (current === "local-setup") {
      // Move to server-url with localhost pre-filled
      if (!serverUrl().trim()) {
        setServerUrl("http://127.0.0.1:8080");
      }
      setStep("server-url");
    } else if (current === "remote-info") {
      setStep("server-url");
    }
  }

  function goBack() {
    setError("");
    const current = step();
    if (current === "connect-or-create") {
      navigate("/", { replace: true });
    } else if (current === "hosting") setStep("connect-or-create");
    else if (current === "has-server") setStep("hosting");
    else if (current === "server-url") {
      // Came either from connect-or-create (existing server flow) or from
      // local-setup / remote-info during create flow.
      setHealthStatus("idle");
      setHealthMessage("");
      if (createdNewServer()) {
        // Created flow: go back to whichever sub-step seeded the URL.
        // Default to has-server since both local/remote land on server-url.
        setStep("has-server");
      } else {
        setStep("connect-or-create");
      }
    } else if (current === "local-setup") setStep("has-server");
    else if (current === "remote-info") setStep("has-server");
    else if (current === "login") {
      if (hostingMode() === "self-host") setStep("server-url");
      else setStep("hosting");
    } else if (current === "signup") setStep("login");
  }

  // True when the user picked "Create a new one" instead of "Connect to existing".
  // We need this because the server-url step is reachable from both branches.
  const [createdNewServer, setCreatedNewServer] = createSignal(false);

  async function handleLogin() {
    if (!email().trim() || !password().trim()) {
      setError(t("error_enter_credentials"));
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api.login(getEffectiveUrl(), {
        email: email(),
        password: password(),
      });
      setToken(result.token);
      setTenantId(result.tenant_id);
      storeEmail(email());
      completeSetup();
    } catch (e: any) {
      setError(
        e?.body ??
          e?.message ??
          t("error_login_failed")
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister() {
    if (!email().trim() || !password().trim()) {
      setError(t("error_enter_credentials"));
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api.register(getEffectiveUrl(), {
        email: email(),
        password: password(),
        display_name: email(),
      });
      setToken(result.token);
      setTenantId(result.tenant_id);
      storeEmail(email());
      completeSetup();
    } catch (e: any) {
      setError(e?.body ?? e?.message ?? t("error_register_failed"));
    } finally {
      setLoading(false);
    }
  }

  function completeSetup() {
    setConfig({
      hostingMode: hostingMode(),
      serverUrl: hostingMode() === "self-host" ? serverUrl() : MANAGED_BASE,
      setupComplete: true,
    });
    navigate("/plugins", { replace: true });
  }

  function handleStubSignup() {
    setError(t("error_managed_signup"));
  }

  // -- local binary detection --

  async function runBinaryDetection() {
    setBinaryStatus("checking");
    const result = await detectBinary();
    if (result.found) {
      setBinaryStatus("found");
      if (result.path) setBinaryPath(result.path);
    } else {
      setBinaryStatus("not-found");
    }
  }

  // Kick off detection when entering local-setup step
  createEffect(() => {
    if (step() === "local-setup" && binaryStatus() === "unknown") {
      runBinaryDetection();
    }
  });

  // Debounced validation of manually edited binary path.
  // Uses untrack on binaryStatus to avoid re-triggering when the status signal changes.
  const debouncedBinaryPath = useDebounce(() => binaryPath(), 500);
  createEffect(() => {
    const path = debouncedBinaryPath();
    if (!path.trim()) return;
    // Don't re-validate if already checking (read without tracking to avoid loop)
    if (untrack(binaryStatus) === "checking") return;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        setBinaryStatus("checking");
        const result = await invoke<{ found: boolean; path?: string }>(
          "validate_binary",
          { path }
        );
        setBinaryStatus(result.found ? "found" : "not-found");

        // Auto-discover the web server URL if the binary is valid
        if (result.found) {
          try {
            const info = await invoke<{ proxy?: string; web?: string }>(
              "discover_server_url",
              { binaryPath: path }
            );
            if (info.web) {
              // Pre-fill the server URL for the next step
              const webUrl = info.web.startsWith("http") ? info.web : `https://${info.web}`;
              setServerUrl(webUrl);
            }
            if (info.proxy) {
              // Persist the real proxy URL so the system-proxy install can
              // target the actual ephemeral port instead of guessing :8080.
              setConfig({ proxyUrl: info.proxy });
            }
          } catch {
            // Discovery is best-effort
          }
        }
      } catch {
        // Not in Tauri, can't validate
      }
    })();
  });

  // -- individual setup step handlers --

  async function checkServiceRunning() {
    setServiceState("checking");
    setStepMessage("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ success: boolean; already_done: boolean; message: string }>(
        "check_service_running",
        { binaryPath: binaryPath() }
      );
      setServiceState(result.success ? "done" : "needed");
      setStepMessage(result.message);
    } catch (e: any) {
      setServiceState("error");
      setStepMessage(e?.message ?? "Could not check service status");
    }
  }

  async function doStartService() {
    setServiceState("checking");
    setStepMessage("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ success: boolean; already_done: boolean; message: string }>(
        "start_service",
        { binaryPath: binaryPath() }
      );
      setServiceState(result.success ? "done" : "error");
      setStepMessage(result.message);
    } catch (e: any) {
      setServiceState("error");
      setStepMessage(e?.message ?? "Failed to start service");
    }
  }

  async function checkCaStatus() {
    setCaState("checking");
    setStepMessage("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ success: boolean; already_done: boolean; message: string }>(
        "check_ca_status",
        { binaryPath: binaryPath() }
      );
      setCaState(result.already_done ? "done" : "needed");
      setStepMessage(result.message);
    } catch (e: any) {
      setCaState("error");
      setStepMessage(e?.message ?? "Failed to check CA status");
    }
  }

  async function doInstallCa() {
    setCaState("checking");
    setStepMessage("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ success: boolean; already_done: boolean; message: string }>(
        "install_ca",
        { binaryPath: binaryPath() }
      );
      setCaState(result.success ? "done" : "error");
      setStepMessage(result.message);
    } catch (e: any) {
      setCaState("error");
      setStepMessage(e?.message ?? "Failed to install CA");
    }
  }

  async function doEnableProxy() {
    setProxyState("checking");
    setStepMessage("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Prefer the discovered proxy URL (real ephemeral port). The web
      // server URL is NOT a proxy — only fall back to a localhost guess.
      const proxyUrl = getConfig()?.proxyUrl?.trim() || "http://127.0.0.1:8080";
      // Bypass loopback and the web-server hostname so the management UI
      // is never routed through the proxy.
      const bypassHosts: string[] = ["localhost", "127.0.0.1", "::1", "*.local"];
      try {
        const u = new URL(serverUrl().trim());
        if (u.hostname) bypassHosts.push(u.hostname);
      } catch {
        // ignore — the server URL may be empty at this point
      }
      const result = await invoke<{ success: boolean; already_done: boolean; message: string }>(
        "enable_proxy",
        { proxyUrl, bypassHosts }
      );
      setProxyState(result.success ? "done" : "error");
      setStepMessage(result.message);
    } catch (e: any) {
      setProxyState("error");
      setStepMessage(e?.message ?? "Failed to enable proxy");
    }
  }

  async function runAllChecks() {
    await checkServiceRunning();
    if (serviceState() !== "done") return;
    await checkCaStatus();
    if (caState() !== "done" && caState() !== "needed") return;
    // Don't auto-install CA -- let user click the button
  }

  // -- step numbers --

  const stepNumber = () => {
    const s = step();
    // Connect flow: connect-or-create → server-url → login (3 steps)
    if (!createdNewServer()) {
      if (s === "connect-or-create") return 1;
      if (s === "server-url") return 2;
      if (s === "login" || s === "signup") return 3;
      return 1;
    }
    // Create flow: connect-or-create → hosting → (has-server → local/remote → server-url) → login
    if (s === "connect-or-create") return 1;
    if (s === "hosting") return 2;
    if (hostingMode() === "managed") {
      if (s === "login" || s === "signup") return 3;
      return 2;
    }
    if (s === "has-server") return 3;
    if (s === "local-setup" || s === "remote-info") return 4;
    if (s === "server-url") return 5;
    if (s === "login" || s === "signup") return 6;
    return 1;
  };

  const totalSteps = () => {
    if (!createdNewServer()) return 3;
    if (hostingMode() === "managed") return 3;
    return 6;
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div class="relative min-h-screen flex flex-col items-center justify-center p-4">
      <DayNightScene />

      <div class="relative z-10 w-full max-w-md animate-fade-in">
        {/* Logo */}
        <div class="text-center mb-6 flex flex-col items-center gap-1">
          <EzfilterLogo
            size="text-5xl"
            class="text-[rgb(var(--color-text))]"
          />
          <p class="text-sm text-[rgb(var(--color-text-muted))] font-display mt-1">
            {t("setup_heading")}
          </p>
        </div>

        {/* Progress */}
        <div class="flex items-center justify-center gap-2 mb-6">
          {Array.from({ length: totalSteps() }, (_, i) => {
            const pillStep = i + 1;
            const reached = pillStep <= stepNumber();
            return (
              <div
                class={`h-1.5 rounded-full transition-all duration-300 ${
                  reached
                    ? "w-10 bg-[rgb(var(--color-primary))]"
                    : "w-6 bg-[rgb(var(--color-border))]"
                }`}
              />
            );
          })}
        </div>

        <Card class="backdrop-blur-sm bg-[rgb(var(--color-surface))]/90">
          <SolidSwitch>
            {/* ============================================================
                Step 0: Connect to existing or create new
                ============================================================ */}
            <Match when={step() === "connect-or-create"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <Sparkles class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  {t("setup_choose_action_title")}
                </CardTitle>
                <CardDescription>
                  {t("setup_choose_action_desc")}
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="flex flex-col gap-3">
                  <button
                    class="flex items-center gap-3 rounded-2xl border-2 border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-4 text-left transition-all duration-200 hover:border-[rgb(var(--color-primary))]/50 hover:shadow-md"
                    onClick={() => {
                      setError("");
                      setCreatedNewServer(true);
                      setStep("hosting");
                    }}
                  >
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-500/10">
                      <Sparkles class="h-5 w-5 text-green-500" />
                    </div>
                    <div class="flex flex-col gap-0.5">
                      <span class="text-sm font-bold font-display">
                        {t("setup_choose_action_create")}
                      </span>
                      <span class="text-xs text-[rgb(var(--color-text-muted))]">
                        {t("setup_choose_action_create_desc")}
                      </span>
                    </div>
                    <ArrowRight class="ml-auto h-4 w-4 text-[rgb(var(--color-text-muted))]" />
                  </button>

                  <button
                    class="flex items-center gap-3 rounded-2xl border-2 border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-4 text-left transition-all duration-200 hover:border-[rgb(var(--color-primary))]/50 hover:shadow-md"
                    onClick={() => {
                      setError("");
                      setCreatedNewServer(false);
                      setHostingMode("self-host");
                      setStep("server-url");
                    }}
                  >
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
                      <LinkIcon class="h-5 w-5 text-blue-500" />
                    </div>
                    <div class="flex flex-col gap-0.5">
                      <span class="text-sm font-bold font-display">
                        {t("setup_choose_action_connect")}
                      </span>
                      <span class="text-xs text-[rgb(var(--color-text-muted))]">
                        {t("setup_choose_action_connect_desc")}
                      </span>
                    </div>
                    <ArrowRight class="ml-auto h-4 w-4 text-[rgb(var(--color-text-muted))]" />
                  </button>
                </div>
              </CardContent>
            </Match>

            {/* ============================================================
                Step 1: Hosting mode
                ============================================================ */}
            <Match when={step() === "hosting"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <Cloud class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  {t("setup_hosting_title")}
                </CardTitle>
                <CardDescription>
                  {t("setup_hosting_description")}
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <RadioGroup
                  value={hostingMode()}
                  onChange={(v) => setHostingMode(v as HostingMode)}
                  options={[
                    {
                      value: "managed",
                      label: t("setup_hosting_managed_label"),
                      description: t("setup_hosting_managed_desc"),
                    },
                    {
                      value: "self-host",
                      label: t("setup_hosting_selfhost_label"),
                      description: t("setup_hosting_selfhost_desc"),
                    },
                  ]}
                />
                <div class="flex justify-between pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    {t("common_back")}
                  </Button>
                  <Button onClick={goNext}>
                    {t("common_continue")}
                    <ArrowRight class="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Match>

            {/* ============================================================
                Step 2: Where to set up your server (local vs remote)
                ============================================================ */}
            <Match when={step() === "has-server"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <Server class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  {t("setup_has_server_title")}
                </CardTitle>
                <CardDescription>
                  {t("setup_has_server_desc")}
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="flex flex-col gap-3">
                  <button
                    class="flex items-center gap-3 rounded-2xl border-2 border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-4 text-left transition-all duration-200 hover:border-[rgb(var(--color-primary))]/50 hover:shadow-md"
                    onClick={() => {
                      setError("");
                      setStep("local-setup");
                    }}
                  >
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
                      <Monitor class="h-5 w-5 text-blue-500" />
                    </div>
                    <div class="flex flex-col gap-0.5">
                      <span class="text-sm font-bold font-display">
                        {t("setup_has_server_local")}
                      </span>
                      <span class="text-xs text-[rgb(var(--color-text-muted))]">
                        {t("setup_has_server_local_desc")}
                      </span>
                    </div>
                    <ArrowRight class="ml-auto h-4 w-4 text-[rgb(var(--color-text-muted))]" />
                  </button>

                  <button
                    class="flex items-center gap-3 rounded-2xl border-2 border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-4 text-left transition-all duration-200 hover:border-[rgb(var(--color-primary))]/50 hover:shadow-md"
                    onClick={() => {
                      setError("");
                      setStep("remote-info");
                    }}
                  >
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/10">
                      <Globe class="h-5 w-5 text-purple-500" />
                    </div>
                    <div class="flex flex-col gap-0.5">
                      <span class="text-sm font-bold font-display">
                        {t("setup_has_server_remote")}
                      </span>
                      <span class="text-xs text-[rgb(var(--color-text-muted))]">
                        {t("setup_has_server_remote_desc")}
                      </span>
                    </div>
                    <ArrowRight class="ml-auto h-4 w-4 text-[rgb(var(--color-text-muted))]" />
                  </button>
                </div>

                <div class="flex justify-start pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    {t("common_back")}
                  </Button>
                </div>
              </CardContent>
            </Match>

            {/* ============================================================
                Step 3a: Local setup
                ============================================================ */}
            <Match when={step() === "local-setup"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <HardDrive class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  {t("setup_local_title")}
                </CardTitle>
                <CardDescription>
                  {t("setup_local_desc")}
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-5 min-h-[200px]">
                {/* Binary path */}
                <div class="rounded-xl border border-[rgb(var(--color-border))] p-4 space-y-3">
                  <div class="flex items-center justify-between">
                    <span class="text-sm font-bold font-display">
                      {t("setup_local_binary_label")}
                    </span>
                    <SolidSwitch>
                      <Match when={binaryStatus() === "checking"}>
                        <span class="flex items-center gap-1.5 text-xs text-[rgb(var(--color-text-muted))]">
                          <Loader2 class="h-3.5 w-3.5 animate-spin" />
                          {t("setup_local_path_checking")}
                        </span>
                      </Match>
                      <Match when={binaryStatus() === "found"}>
                        <span class="flex items-center gap-1.5 text-xs text-green-500 font-medium">
                          <Check class="h-3.5 w-3.5" />
                          {t("setup_local_path_valid")}
                        </span>
                      </Match>
                      <Match when={binaryStatus() === "not-found"}>
                        <span class="flex items-center gap-1.5 text-xs text-red-500 font-medium">
                          <X class="h-3.5 w-3.5" />
                          {t("setup_local_not_found")}
                        </span>
                      </Match>
                      <Match when={binaryStatus() === "unknown"}>
                        <span class="text-xs text-[rgb(var(--color-text-muted))]">
                          {t("setup_local_pending")}
                        </span>
                      </Match>
                    </SolidSwitch>
                  </div>

                  {/* Editable path input */}
                  <div class="flex gap-2">
                    <Input
                      type="text"
                      value={binaryPath()}
                      onInput={(e) => setBinaryPath(e.currentTarget.value)}
                      placeholder="/usr/local/bin/witm"
                      class="font-mono text-xs flex-1"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        const path = await pickBinaryFile();
                        if (path) setBinaryPath(path);
                      }}
                    >
                      <FolderOpen class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p class="text-xs text-[rgb(var(--color-text-muted))]">
                    {t("setup_local_path_hint")}
                  </p>

                  <Show when={binaryStatus() === "not-found" && !binaryPath().trim()}>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      {t("setup_local_not_detected")}
                    </p>
                    <div class="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => window.open(DOWNLOAD_URL, "_blank")}
                      >
                        <Download class="h-3.5 w-3.5" />
                        {t("setup_local_download")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setBinaryStatus("unknown");
                          runBinaryDetection();
                        }}
                      >
                        {t("setup_local_recheck")}
                      </Button>
                    </div>
                  </Show>
                </div>

                {/* Setup steps (shown once binary is found) */}
                <Show when={binaryStatus() === "found"}>
                  <div class="rounded-xl border border-[rgb(var(--color-border))] p-4 space-y-4">
                    <span class="text-sm font-bold font-display">
                      {t("setup_local_configure")}
                    </span>

                    {/* Step 1: Service running */}
                    <div class="flex items-center justify-between">
                      <div class="flex-1">
                        <p class="text-sm font-display font-semibold">{t("setup_local_step_running")}</p>
                        <p class="text-xs text-[rgb(var(--color-text-muted))]">{t("setup_local_step_running_desc")}</p>
                      </div>
                      <div class="flex items-center gap-2">
                        <Show when={serviceState() === "done"}>
                          <Check class="h-4 w-4 text-green-500" />
                        </Show>
                        <Show when={serviceState() === "checking"}>
                          <Loader2 class="h-4 w-4 animate-spin text-[rgb(var(--color-text-muted))]" />
                        </Show>
                        <Show when={serviceState() === "error"}>
                          <X class="h-4 w-4 text-red-500" />
                        </Show>
                        <Show when={serviceState() === "idle" || serviceState() === "needed"}>
                          <Button size="sm" variant="secondary" onClick={serviceState() === "needed" ? doStartService : checkServiceRunning}>
                            {serviceState() === "needed" ? t("setup_local_install") : t("setup_local_check")}
                          </Button>
                        </Show>
                      </div>
                    </div>

                    {/* Step 2: CA trusted */}
                    <div class="flex items-center justify-between">
                      <div class="flex-1">
                        <p class="text-sm font-display font-semibold">{t("setup_local_step_ca")}</p>
                        <p class="text-xs text-[rgb(var(--color-text-muted))]">{t("setup_local_step_ca_desc")}</p>
                      </div>
                      <div class="flex items-center gap-2">
                        <Show when={caState() === "done"}>
                          <Check class="h-4 w-4 text-green-500" />
                        </Show>
                        <Show when={caState() === "checking"}>
                          <Loader2 class="h-4 w-4 animate-spin text-[rgb(var(--color-text-muted))]" />
                        </Show>
                        <Show when={caState() === "error"}>
                          <X class="h-4 w-4 text-red-500" />
                        </Show>
                        <Show when={caState() === "idle"}>
                          <Button size="sm" variant="secondary" onClick={checkCaStatus}>
                            {t("setup_local_check")}
                          </Button>
                        </Show>
                        <Show when={caState() === "needed"}>
                          <Button size="sm" variant="secondary" onClick={doInstallCa}>
                            {t("setup_local_install")}
                          </Button>
                        </Show>
                      </div>
                    </div>

                    {/* Step 3: System proxy */}
                    <div class="flex items-center justify-between">
                      <div class="flex-1">
                        <p class="text-sm font-display font-semibold">{t("setup_local_step_proxy")}</p>
                        <p class="text-xs text-[rgb(var(--color-text-muted))]">{t("setup_local_step_proxy_desc")}</p>
                      </div>
                      <div class="flex items-center gap-2">
                        <Show when={proxyState() === "done"}>
                          <Check class="h-4 w-4 text-green-500" />
                        </Show>
                        <Show when={proxyState() === "checking"}>
                          <Loader2 class="h-4 w-4 animate-spin text-[rgb(var(--color-text-muted))]" />
                        </Show>
                        <Show when={proxyState() === "error"}>
                          <X class="h-4 w-4 text-red-500" />
                        </Show>
                        <Show when={proxyState() === "idle" || proxyState() === "needed"}>
                          <Button size="sm" variant="secondary" onClick={doEnableProxy}>
                            {t("setup_local_enable")}
                          </Button>
                        </Show>
                      </div>
                    </div>

                    {/* Status message */}
                    <Show when={stepMessage()}>
                      <p class="text-xs text-[rgb(var(--color-text-muted))] font-mono">{stepMessage()}</p>
                    </Show>

                    {/* All done indicator */}
                    <Show when={allStepsDone()}>
                      <p class="flex items-center gap-1.5 text-xs text-green-500 font-medium">
                        <Check class="h-3.5 w-3.5" />
                        {t("setup_local_running")}
                      </p>
                    </Show>
                  </div>
                </Show>

                <Show when={error()}>
                  <p class="text-sm text-red-500 font-medium">{error()}</p>
                </Show>

                <div class="flex justify-between pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    {t("common_back")}
                  </Button>
                  <Button onClick={goNext}>
                    {t("common_continue")}
                    <ArrowRight class="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Match>

            {/* ============================================================
                Step 3b: Remote info
                ============================================================ */}
            <Match when={step() === "remote-info"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <Globe class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  {t("setup_remote_title")}
                </CardTitle>
                <CardDescription>
                  {t("setup_remote_desc")}
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="rounded-xl border border-[rgb(var(--color-border))] p-4 space-y-3">
                  <p class="text-sm text-[rgb(var(--color-text-secondary))]">
                    {t("setup_remote_self_manage")}
                  </p>
                  <ul class="list-disc list-inside text-sm text-[rgb(var(--color-text-muted))] space-y-1">
                    <li>{t("setup_remote_doc_docker")}</li>
                    <li>{t("setup_remote_doc_systemd")}</li>
                    <li>{t("setup_remote_doc_tls")}</li>
                    <li>{t("setup_remote_doc_env")}</li>
                  </ul>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.open(DOCS_URL, "_blank")}
                  >
                    <ExternalLink class="h-3.5 w-3.5" />
                    {t("setup_remote_open_docs")}
                  </Button>
                </div>

                <p class="text-xs text-[rgb(var(--color-text-muted))]">
                  {t("setup_remote_ready")}
                </p>

                <div class="flex justify-between pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    {t("common_back")}
                  </Button>
                  <Button onClick={goNext}>
                    {t("common_continue")}
                    <ArrowRight class="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Match>

            {/* ============================================================
                Step 3c / 4: Server URL (self-host) with health check
                ============================================================ */}
            <Match when={step() === "server-url"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <Server class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  {t("setup_server_title")}
                </CardTitle>
                <CardDescription>
                  {t("setup_server_desc")}
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="space-y-2">
                  <Label for="server-url">{t("setup_server_url_label")}</Label>
                  <div class="relative">
                    <Input
                      id="server-url"
                      type="url"
                      placeholder={t("setup_server_url_placeholder")}
                      value={serverUrl()}
                      onInput={(e) => setServerUrl(e.currentTarget.value)}
                      class="pr-10"
                    />
                    {/* Health status icon inside input */}
                    <Show when={healthStatus() !== "idle"}>
                      <div class="absolute right-3 top-1/2 -translate-y-1/2">
                        <SolidSwitch>
                          <Match when={healthStatus() === "checking"}>
                            <Loader2 class="h-4 w-4 animate-spin text-[rgb(var(--color-text-muted))]" />
                          </Match>
                          <Match when={healthStatus() === "ok"}>
                            <Check class="h-4 w-4 text-green-500" />
                          </Match>
                          <Match when={healthStatus() === "error"}>
                            <X class="h-4 w-4 text-red-500" />
                          </Match>
                          <Match when={healthStatus() === "tls-error"}>
                            <ShieldCheck class="h-4 w-4 text-red-500" />
                          </Match>
                        </SolidSwitch>
                      </div>
                    </Show>
                  </div>
                  {/* Status text below input — replaces the hint when a status is active */}
                  <SolidSwitch>
                    <Match when={healthStatus() === "ok"}>
                      <p class="text-xs text-green-600 dark:text-green-400">{t("setup_server_healthy")}</p>
                    </Match>
                    <Match when={healthStatus() === "error"}>
                      <p class="text-xs text-red-600 dark:text-red-400">{healthMessage() || t("error_server_unreachable")}</p>
                    </Match>
                    <Match when={healthStatus() === "tls-error"}>
                      <p class="text-xs text-red-600 dark:text-red-400">{t("setup_server_tls_error")}</p>
                    </Match>
                    <Match when={healthStatus() === "checking"}>
                      <p class="text-xs text-[rgb(var(--color-text-muted))]">{t("setup_server_wait_health")}</p>
                    </Match>
                    <Match when={true}>
                      <p class="text-xs text-[rgb(var(--color-text-muted))]">{t("setup_server_url_hint")}</p>
                    </Match>
                  </SolidSwitch>
                </div>

                <Show when={error()}>
                  <p class="text-sm text-red-500 font-medium">{error()}</p>
                </Show>
                <div class="flex justify-between pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    {t("common_back")}
                  </Button>
                  <Button
                    onClick={goNext}
                    disabled={healthStatus() !== "ok"}
                  >
                    {t("common_continue")}
                    <ArrowRight class="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Match>

            {/* ============================================================
                Login
                ============================================================ */}
            <Match when={step() === "login"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <LogIn class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  {t("setup_login_title")}
                </CardTitle>
                <CardDescription>
                  <Show
                    when={hostingMode() === "managed"}
                    fallback={
                      <>
                        {t("setup_login_desc_selfhost", serverUrl())}
                      </>
                    }
                  >
                    {t("setup_login_desc_managed")}
                  </Show>
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="space-y-2">
                  <Label for="email">{t("common_email")}</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder={t("setup_login_email_placeholder")}
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                  />
                </div>
                <div class="space-y-2">
                  <Label for="password">{t("common_password")}</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder={t("setup_login_password_placeholder")}
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleLogin();
                    }}
                  />
                </div>
                <Show when={error()}>
                  <p class="text-sm text-red-500 font-medium">{error()}</p>
                </Show>
                <div class="flex flex-col gap-3 pt-2">
                  <Button onClick={handleLogin} disabled={loading()}>
                    <Show when={loading()} fallback={<>{t("setup_login_btn")}</>}>
                      {t("setup_login_btn_loading")}
                    </Show>
                  </Button>
                  <div class="text-center">
                    <button
                      class="text-sm text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-primary))] font-display font-medium transition-colors"
                      onClick={() => {
                        setError("");
                        setStep("signup");
                      }}
                    >
                      {t("setup_login_no_account")}{" "}
                      <span class="underline">{t("setup_login_sign_up")}</span>
                    </button>
                  </div>
                </div>
                <div class="flex justify-start pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    {t("common_back")}
                  </Button>
                </div>
              </CardContent>
            </Match>

            {/* ============================================================
                Sign up
                ============================================================ */}
            <Match when={step() === "signup"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <UserPlus class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  {t("setup_signup_title")}
                </CardTitle>
                <CardDescription>
                  <Show
                    when={hostingMode() === "self-host"}
                    fallback={<>{t("setup_signup_desc_managed")}</>}
                  >
                    {t("setup_signup_desc_selfhost", serverUrl())}
                  </Show>
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="space-y-2">
                  <Label for="reg-email">{t("common_email")}</Label>
                  <Input
                    id="reg-email"
                    type="email"
                    placeholder={t("setup_login_email_placeholder")}
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                  />
                </div>
                <div class="space-y-2">
                  <Label for="reg-password">{t("common_password")}</Label>
                  <Input
                    id="reg-password"
                    type="password"
                    placeholder={t("setup_signup_password_placeholder")}
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (hostingMode() === "managed") handleStubSignup();
                        else handleRegister();
                      }
                    }}
                  />
                </div>
                <Show when={error()}>
                  <p class="text-sm text-red-500 font-medium">{error()}</p>
                </Show>
                <div class="flex flex-col gap-3 pt-2">
                  <Button
                    onClick={() => {
                      if (hostingMode() === "managed") handleStubSignup();
                      else handleRegister();
                    }}
                    disabled={loading()}
                  >
                    <Show when={loading()} fallback={<>{t("setup_signup_btn")}</>}>
                      {t("setup_signup_btn_loading")}
                    </Show>
                  </Button>
                  <div class="text-center">
                    <button
                      class="text-sm text-[rgb(var(--color-text-muted))] hover:text-[rgb(var(--color-primary))] font-display font-medium transition-colors"
                      onClick={() => {
                        setError("");
                        setStep("login");
                      }}
                    >
                      {t("setup_signup_has_account")}{" "}
                      <span class="underline">{t("setup_signup_sign_in")}</span>
                    </button>
                  </div>
                </div>
                <div class="flex justify-start pt-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setError("");
                      setStep("login");
                    }}
                  >
                    <ArrowLeft class="h-4 w-4" />
                    {t("common_back")}
                  </Button>
                </div>
              </CardContent>
            </Match>
          </SolidSwitch>
        </Card>
      </div>
    </div>
  );
}
