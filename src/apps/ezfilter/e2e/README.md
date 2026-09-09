# ezfilter E2E Tests

End-to-end tests that drive the real ezfilter Tauri app against a real witmproxy backend using WebDriver.

## Prerequisites

1. **tauri-driver** — WebDriver server for Tauri apps:
   ```sh
   cargo install tauri-driver
   ```

2. **Built ezfilter binary**:
   ```sh
   cd src-tauri && cargo build
   ```

3. **Built WASM test plugins** (for plugin tests):
   ```sh
   cd src/rust/wasm-test-component && cargo build --target wasm32-wasip2 --release
   ```

## Running

```sh
cargo test -p ezfilter-e2e
```

Tests skip gracefully if `tauri-driver` or the ezfilter binary isn't available.

## What's tested

| Test | Description |
|------|-------------|
| `onboarding_selfhosted_login` | Self-hosted setup flow → login → lands on plugins page |
| `import_plugin_and_verify_effect` | Plugin appears in list and modifies proxied traffic |
| `remove_plugin` | Removing a plugin clears it from UI and backend |
| `disable_plugin` | Disabling a plugin shows disabled state, stops affecting traffic |
| `logout_returns_to_onboarding` | Logout clears state and returns to setup flow |
