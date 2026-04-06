import { createSignal, Show, Switch as SolidSwitch, Match } from "solid-js";
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
} from "lucide-solid";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import { RadioGroup } from "../components/ui/radio-group";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { DayNightScene } from "../components/day-night-scene";
import { ThemeToggle } from "../components/theme-toggle";
import { setConfig, type HostingMode } from "../lib/stores/config";
import { WitmproxyClient } from "../lib/api/client";
import { setToken } from "../lib/stores/auth";

type Step = "hosting" | "server" | "login" | "signup";

export default function SetupPage() {
  const navigate = useNavigate();

  const [step, setStep] = createSignal<Step>("hosting");
  const [hostingMode, setHostingMode] = createSignal<HostingMode>("managed");
  const [serverUrl, setServerUrl] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  const API_VERSION = "v1";
  const MANAGED_BASE = "https://ezfilter.joinez.co";

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
        setStep("server");
      } else {
        setStep("login");
      }
    } else if (current === "server") {
      if (!serverUrl().trim()) {
        setError("Please enter a server URL");
        return;
      }
      setStep("login");
    } else if (current === "login") {
      // handled by login form submit
    }
  }

  function goBack() {
    setError("");
    const current = step();
    if (current === "server") setStep("hosting");
    else if (current === "login") {
      if (hostingMode() === "self-host") setStep("server");
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
      const client = new WitmproxyClient(getEffectiveUrl());
      const result = await client.login({ email: email(), password: password() });
      setToken(result.token);
      completeSetup();
    } catch (e: any) {
      setError(e?.body ?? e?.message ?? "Login failed. Check your credentials and server URL.");
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
      const client = new WitmproxyClient(getEffectiveUrl());
      const result = await client.register({
        email: email(),
        password: password(),
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

  // For the stubbed signup on managed
  function handleStubSignup() {
    setError("Account registration is not yet available for managed hosting. Please use self-hosting for now.");
  }

  const stepNumber = () => {
    const s = step();
    if (s === "hosting") return 1;
    if (s === "server") return 2;
    if (s === "login") return hostingMode() === "self-host" ? 3 : 2;
    if (s === "signup") return hostingMode() === "self-host" ? 3 : 2;
    return 1;
  };

  const totalSteps = () => (hostingMode() === "self-host" ? 3 : 2);

  return (
    <div class="relative min-h-screen flex flex-col items-center justify-center p-4">
      <DayNightScene />

      <div class="absolute top-4 right-4 z-20">
        <ThemeToggle />
      </div>

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
            {/* Step 1: Hosting mode */}
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

            {/* Step 2a: Server URL (self-host only) */}
            <Match when={step() === "server"}>
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
                  <Input
                    id="server-url"
                    type="url"
                    placeholder="https://my-proxy.example.com"
                    value={serverUrl()}
                    onInput={(e) => setServerUrl(e.currentTarget.value)}
                  />
                  <p class="text-xs text-[rgb(var(--color-text-muted))]">
                    The full URL including protocol (https://)
                  </p>
                </div>
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

            {/* Step 3: Login */}
            <Match when={step() === "login"}>
              <CardHeader>
                <CardTitle class="flex items-center gap-2">
                  <LogIn class="h-5 w-5 text-[rgb(var(--color-primary))]" />
                  Sign in to your account
                </CardTitle>
                <CardDescription>
                  <Show
                    when={hostingMode() === "managed"}
                    fallback={<>Sign in to your server at <span class="font-mono text-xs">{serverUrl()}</span></>}
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
                    onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
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
                      Don't have an account? <span class="underline">Sign up</span>
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

            {/* Step 3 alt: Sign up */}
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
                    Register on your server at <span class="font-mono text-xs">{serverUrl()}</span>
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
                      Already have an account? <span class="underline">Sign in</span>
                    </button>
                  </div>
                </div>
                <div class="flex justify-start pt-2">
                  <Button variant="ghost" onClick={() => { setError(""); setStep("login"); }}>
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
