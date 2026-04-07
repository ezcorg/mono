import {
  createSignal,
  createEffect,
  onCleanup,
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
import { setConfig, type HostingMode } from "../lib/stores/config";
import { api } from "../lib/api/client";
import { setToken } from "../lib/stores/auth";

type Step =
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
      return { status: "error", message: "URL must start with http:// or https://" };
    }
  } catch {
    return { status: "error", message: "Please enter a valid URL (e.g. https://my-server:9443)" };
  }

  try {
    const url = `${baseUrl.trim().replace(/\/+$/, "")}/api/health`;
    const res = await fetch(url);
    if (res.ok) return { status: "ok" };
    return {
      status: "error",
      message: `Server responded with ${res.status} ${res.statusText}`,
    };
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    // Browsers surface TLS failures as TypeErrors with messages containing
    // keywords like "SSL", "certificate", "CERT", or "ERR_CERT".
    if (/ssl|certificate|cert|tls|ERR_CERT/i.test(msg)) {
      return {
        status: "tls-error",
        message:
          "TLS/SSL error — the server's certificate may be self-signed or untrusted. " +
          "If running locally, make sure you have trusted the certificate or use http:// instead.",
      };
    }
    return {
      status: "error",
      message: `Could not reach the server. Make sure it is running and the URL is correct.`,
    };
  }
}

/** Try to detect `witmproxy` on the local system via Tauri invoke. */
async function detectBinary(): Promise<{
  found: boolean;
  path?: string;
}> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // We assume a Tauri command `check_binary` is (or will be) registered.
    // If the command doesn't exist yet, the invoke will throw and we
    // fall through to the catch below.
    const result = await invoke<{ found: boolean; path?: string }>(
      "check_binary",
      { name: "witmproxy" }
    );
    return result;
  } catch {
    // Not running inside Tauri or command not available — try a heuristic
    // by hitting localhost:8080/api/health which is the default port.
    try {
      const res = await fetch("http://127.0.0.1:8080/api/health", {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok)
        return { found: true, path: "http://127.0.0.1:8080 (running)" };
    } catch {
      // ignore
    }
    return { found: false };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SetupPage() {
  const navigate = useNavigate();

  // -- wizard state --
  const [step, setStep] = createSignal<Step>("hosting");
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
  const [localSetupDone, setLocalSetupDone] = createSignal(false);

  const API_VERSION = "v1";
  const MANAGED_BASE = "https://ezfilter.joinez.co";
  const DOCS_URL = "https://docs.ezfilter.joinez.co/self-host";
  const DOWNLOAD_URL = "https://github.com/nicholasgasior/witmproxy/releases";

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
        setError("Please enter a server URL");
        return;
      }
      if (healthStatus() === "checking") {
        setError("Waiting for health check to complete...");
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
    if (current === "has-server") setStep("hosting");
    else if (current === "server-url") {
      setStep("has-server");
      setHealthStatus("idle");
      setHealthMessage("");
    } else if (current === "local-setup") setStep("has-server");
    else if (current === "remote-info") setStep("has-server");
    else if (current === "login") {
      if (hostingMode() === "self-host") setStep("server-url");
      else setStep("hosting");
    } else if (current === "signup") setStep("login");
  }

  async function handleLogin() {
    if (!email().trim() || !password().trim()) {
      setError("Please enter your email and password");
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
      completeSetup();
    } catch (e: any) {
      setError(
        e?.body ??
          e?.message ??
          "Login failed. Check your credentials and server URL."
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister() {
    if (!email().trim() || !password().trim()) {
      setError("Please enter your email and password");
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
      completeSetup();
    } catch (e: any) {
      setError(e?.body ?? e?.message ?? "Registration failed.");
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
    setError(
      "Account registration is not yet available for managed hosting. Please use self-hosting for now."
    );
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

  // -- step numbers --

  const stepNumber = () => {
    const s = step();
    if (s === "hosting") return 1;
    if (s === "has-server") return 2;
    if (s === "local-setup" || s === "remote-info") return 3;
    if (s === "server-url") return hostingMode() === "self-host" ? 3 : 2;
    if (s === "login" || s === "signup")
      return hostingMode() === "self-host" ? 4 : 2;
    return 1;
  };

  const totalSteps = () => (hostingMode() === "self-host" ? 4 : 2);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div class="relative min-h-screen flex flex-col items-center justify-center p-4">
      <DayNightScene />

      <div class="relative z-10 w-full max-w-md animate-fade-in">
        {/* Logo */}
        <div class="text-center mb-6">
          <h1 class="text-3xl font-extrabold font-display tracking-tight">
            <span class="text-[rgb(var(--color-primary))]">ez</span>filter
          </h1>
          <p class="text-sm text-[rgb(var(--color-text-muted))] font-display mt-1">
            Let's get you set up
          </p>
        </div>

        {/* Progress */}
        <div class="flex items-center justify-center gap-2 mb-6">
          {Array.from({ length: totalSteps() }, (_, i) => (
            <div
              class={`h-1.5 rounded-full transition-all duration-300 ${
                i + 1 <= stepNumber()
                  ? "w-10 bg-[rgb(var(--color-primary))]"
                  : "w-6 bg-[rgb(var(--color-border))]"
              }`}
            />
          ))}
        </div>

        <Card class="backdrop-blur-sm bg-[rgb(var(--color-surface))]/90">
          <SolidSwitch>
            {/* ============================================================
                Step 1: Hosting mode
                ============================================================ */}
            <Match when={step() === "hosting"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <Cloud class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  How would you like to run it?
                </CardTitle>
                <CardDescription>
                  Choose between our managed service or your own server
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <RadioGroup
                  value={hostingMode()}
                  onChange={(v) => setHostingMode(v as HostingMode)}
                  options={[
                    {
                      value: "managed",
                      label: "Managed by us",
                      description:
                        "We handle everything for you. Your instance runs privately in an environment supporting confidential computing, where we never have access to your data.",
                    },
                    {
                      value: "self-host",
                      label: "Self-hosted",
                      description:
                        "Connect to your own backend, hosted and maintained by you, locally or remotely.",
                    },
                  ]}
                />
                <div class="flex justify-end pt-2">
                  <Button onClick={goNext}>
                    Continue
                    <ArrowRight class="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Match>

            {/* ============================================================
                Step 2: Do you have a running server already?
                ============================================================ */}
            <Match when={step() === "has-server"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <Server class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  Do you have a running server?
                </CardTitle>
                <CardDescription>
                  If you already have a witmproxy instance running, we can
                  connect to it directly.
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="flex flex-col gap-3">
                  <button
                    class="flex items-center gap-3 rounded-2xl border-2 border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-4 text-left transition-all duration-200 hover:border-[rgb(var(--color-primary))]/50 hover:shadow-md"
                    onClick={() => {
                      setError("");
                      setStep("server-url");
                    }}
                  >
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-500/10">
                      <Check class="h-5 w-5 text-green-500" />
                    </div>
                    <div class="flex flex-col gap-0.5">
                      <span class="text-sm font-bold font-display">
                        Yes, I have a server
                      </span>
                      <span class="text-xs text-[rgb(var(--color-text-muted))]">
                        I'll provide the URL to my running instance
                      </span>
                    </div>
                    <ArrowRight class="ml-auto h-4 w-4 text-[rgb(var(--color-text-muted))]" />
                  </button>

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
                        No — set up locally
                      </span>
                      <span class="text-xs text-[rgb(var(--color-text-muted))]">
                        We'll help you install and configure witmproxy on this
                        machine
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
                        No — set up remotely
                      </span>
                      <span class="text-xs text-[rgb(var(--color-text-muted))]">
                        I'll deploy witmproxy on my own infrastructure
                      </span>
                    </div>
                    <ArrowRight class="ml-auto h-4 w-4 text-[rgb(var(--color-text-muted))]" />
                  </button>
                </div>

                <div class="flex justify-start pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    Back
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
                  Local setup
                </CardTitle>
                <CardDescription>
                  We'll check for witmproxy on your machine and help you get it
                  running.
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-5">
                {/* Binary detection */}
                <div class="rounded-xl border border-[rgb(var(--color-border))] p-4 space-y-3">
                  <div class="flex items-center justify-between">
                    <span class="text-sm font-bold font-display">
                      witmproxy binary
                    </span>
                    <SolidSwitch>
                      <Match when={binaryStatus() === "checking"}>
                        <span class="flex items-center gap-1.5 text-xs text-[rgb(var(--color-text-muted))]">
                          <Loader2 class="h-3.5 w-3.5 animate-spin" />
                          Detecting...
                        </span>
                      </Match>
                      <Match when={binaryStatus() === "found"}>
                        <span class="flex items-center gap-1.5 text-xs text-green-500 font-medium">
                          <Check class="h-3.5 w-3.5" />
                          Found
                        </span>
                      </Match>
                      <Match when={binaryStatus() === "not-found"}>
                        <span class="flex items-center gap-1.5 text-xs text-red-500 font-medium">
                          <X class="h-3.5 w-3.5" />
                          Not found
                        </span>
                      </Match>
                      <Match when={binaryStatus() === "unknown"}>
                        <span class="text-xs text-[rgb(var(--color-text-muted))]">
                          Pending
                        </span>
                      </Match>
                    </SolidSwitch>
                  </div>

                  <Show when={binaryStatus() === "found" && binaryPath()}>
                    <p class="text-xs text-[rgb(var(--color-text-muted))] font-mono break-all">
                      {binaryPath()}
                    </p>
                  </Show>

                  <Show when={binaryStatus() === "not-found"}>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      witmproxy was not detected on your system. You can
                      download it or point to an existing binary.
                    </p>
                    <div class="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          window.open(DOWNLOAD_URL, "_blank");
                        }}
                      >
                        <Download class="h-3.5 w-3.5" />
                        Download
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            const { openUrl } = await import(
                              "@tauri-apps/plugin-opener"
                            );
                            // If in Tauri, we could use a file dialog in the
                            // future. For now, open the docs.
                            await openUrl(DOWNLOAD_URL);
                          } catch {
                            window.open(DOWNLOAD_URL, "_blank");
                          }
                        }}
                      >
                        <FolderOpen class="h-3.5 w-3.5" />
                        Browse...
                      </Button>
                    </div>
                  </Show>

                  <Show
                    when={
                      binaryStatus() === "not-found" ||
                      binaryStatus() === "unknown"
                    }
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setBinaryStatus("unknown");
                        runBinaryDetection();
                      }}
                    >
                      Re-check
                    </Button>
                  </Show>
                </div>

                {/* Setup actions (shown once binary is found) */}
                <Show when={binaryStatus() === "found"}>
                  <div class="rounded-xl border border-[rgb(var(--color-border))] p-4 space-y-3">
                    <span class="text-sm font-bold font-display">
                      Configure proxy
                    </span>
                    <p class="text-xs text-[rgb(var(--color-text-muted))]">
                      These actions will install the CA certificate, trust it in
                      your system store, and start the proxy service.
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={localSetupDone()}
                        onClick={async () => {
                          setLoading(true);
                          setError("");
                          try {
                            const { invoke } = await import(
                              "@tauri-apps/api/core"
                            );
                            await invoke("setup_local_proxy");
                            setLocalSetupDone(true);
                            setServerUrl("http://127.0.0.1:8080");
                          } catch (e: any) {
                            setError(
                              e?.message ??
                                "Failed to set up proxy. You may need to run this manually — see the docs."
                            );
                          } finally {
                            setLoading(false);
                          }
                        }}
                      >
                        <Show
                          when={!loading()}
                          fallback={
                            <Loader2 class="h-3.5 w-3.5 animate-spin" />
                          }
                        >
                          <ShieldCheck class="h-3.5 w-3.5" />
                        </Show>
                        Install, trust & enable
                      </Button>
                    </div>
                    <Show when={localSetupDone()}>
                      <p class="flex items-center gap-1.5 text-xs text-green-500 font-medium">
                        <Check class="h-3.5 w-3.5" />
                        Proxy configured and running on{" "}
                        <span class="font-mono">127.0.0.1:8080</span>
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
                    Back
                  </Button>
                  <Button onClick={goNext}>
                    Continue
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
                  Remote deployment
                </CardTitle>
                <CardDescription>
                  Deploy witmproxy on your own infrastructure, then come back
                  here with the URL.
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="rounded-xl border border-[rgb(var(--color-border))] p-4 space-y-3">
                  <p class="text-sm text-[rgb(var(--color-text-secondary))]">
                    You'll need to set up and manage the server yourself. Our
                    documentation covers:
                  </p>
                  <ul class="list-disc list-inside text-sm text-[rgb(var(--color-text-muted))] space-y-1">
                    <li>Docker / docker-compose deployment</li>
                    <li>Systemd service configuration</li>
                    <li>TLS certificate setup</li>
                    <li>Environment variables & configuration</li>
                  </ul>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.open(DOCS_URL, "_blank")}
                  >
                    <ExternalLink class="h-3.5 w-3.5" />
                    Open documentation
                  </Button>
                </div>

                <p class="text-xs text-[rgb(var(--color-text-muted))]">
                  Once your server is running, click Continue to enter its URL.
                </p>

                <div class="flex justify-between pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={goNext}>
                    Continue
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
                  Where is your server?
                </CardTitle>
                <CardDescription>
                  Enter the URL of your witmproxy web server
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="space-y-2">
                  <Label for="server-url">Server URL</Label>
                  <div class="relative">
                    <Input
                      id="server-url"
                      type="url"
                      placeholder="https://my-proxy.example.com"
                      value={serverUrl()}
                      onInput={(e) => setServerUrl(e.currentTarget.value)}
                      class="pr-10"
                    />
                    {/* Health status indicator */}
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
                          <X class="h-4 w-4 text-red-500" />
                        </Match>
                      </SolidSwitch>
                    </div>
                  </div>
                  <p class="text-xs text-[rgb(var(--color-text-muted))]">
                    The full URL including protocol (https://)
                  </p>
                </div>

                {/* Health check feedback */}
                <Show when={healthStatus() === "ok"}>
                  <p class="text-sm text-green-500 font-medium flex items-center gap-1.5">
                    <Check class="h-4 w-4" />
                    Server is reachable and healthy
                  </p>
                </Show>

                <Show when={healthStatus() === "error" && healthMessage()}>
                  <p class="text-sm text-red-500 font-medium flex items-center gap-1.5">
                    <X class="h-4 w-4 shrink-0" />
                    {healthMessage()}
                  </p>
                </Show>

                <Show when={healthStatus() === "tls-error" && healthMessage()}>
                  <div class="rounded-lg border border-red-500/30 bg-red-500/5 p-3 space-y-1">
                    <p class="text-sm text-red-500 font-medium flex items-center gap-1.5">
                      <ShieldCheck class="h-4 w-4 shrink-0" />
                      TLS certificate error
                    </p>
                    <p class="text-xs text-red-400">{healthMessage()}</p>
                  </div>
                </Show>

                <Show when={error()}>
                  <p class="text-sm text-red-500 font-medium">{error()}</p>
                </Show>
                <div class="flex justify-between pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    Back
                  </Button>
                  <Button
                    onClick={goNext}
                    disabled={healthStatus() === "checking"}
                  >
                    Continue
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
                  Sign in to your account
                </CardTitle>
                <CardDescription>
                  <Show
                    when={hostingMode() === "managed"}
                    fallback={
                      <>
                        Sign in to your server at{" "}
                        <span class="font-mono text-xs">{serverUrl()}</span>
                      </>
                    }
                  >
                    Sign in with your ezfilter account
                  </Show>
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="space-y-2">
                  <Label for="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                  />
                </div>
                <div class="space-y-2">
                  <Label for="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Your password"
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
                    <Show when={loading()} fallback={<>Sign In</>}>
                      Signing in...
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
                      Don't have an account?{" "}
                      <span class="underline">Sign up</span>
                    </button>
                  </div>
                </div>
                <div class="flex justify-start pt-2">
                  <Button variant="ghost" onClick={goBack}>
                    <ArrowLeft class="h-4 w-4" />
                    Back
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
                  Create an account
                </CardTitle>
                <CardDescription>
                  <Show
                    when={hostingMode() === "self-host"}
                    fallback={<>Create your ezfilter account</>}
                  >
                    Register on your server at{" "}
                    <span class="font-mono text-xs">{serverUrl()}</span>
                  </Show>
                </CardDescription>
              </CardHeader>
              <CardContent class="space-y-4">
                <div class="space-y-2">
                  <Label for="reg-email">Email</Label>
                  <Input
                    id="reg-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                  />
                </div>
                <div class="space-y-2">
                  <Label for="reg-password">Password</Label>
                  <Input
                    id="reg-password"
                    type="password"
                    placeholder="Choose a password"
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
                    <Show when={loading()} fallback={<>Create Account</>}>
                      Creating account...
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
                      Already have an account?{" "}
                      <span class="underline">Sign in</span>
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
                    Back
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
