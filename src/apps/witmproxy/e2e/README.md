# witmproxy-test

End-to-end test infrastructure for **witmproxy** and its WASM plugins.

## For plugin authors

Add this crate as a dev-dependency to run the same e2e tests against your
plugin:

```toml
[dev-dependencies]
witmproxy-test = { path = "path/to/witmproxy/e2e" }
tokio = { version = "1", features = ["full"] }
```

Then write integration tests like:

```rust
use witmproxy_test::{TestEnv, Protocol, EchoResponse};

#[tokio::test]
async fn my_plugin_adds_header() -> anyhow::Result<()> {
    let env = TestEnv::start().await?;
    env.register_plugin_from_path("target/wasm32-wasip2/release/my_plugin.signed.wasm").await?;

    let echo = env.start_echo_server("127.0.0.1", Protocol::Http1).await;
    let client = env.create_http_client(Protocol::Http1).await;

    let resp = client
        .get(format!("https://127.0.0.1:{}/test", echo.listen_addr().port()))
        .send()
        .await?;

    // assert your plugin's behaviour here
    assert!(resp.headers().contains_key("x-my-plugin"));

    echo.shutdown().await;
    env.shutdown().await;
    Ok(())
}
```

## Running the full e2e suite

```sh
cargo test -p witmproxy-test
```

Browser / mobile tests require external tools. Tests that need a missing
binary are skipped with a `warning!` message. Required binaries per test
category:

| Category         | Binaries needed                         |
|------------------|-----------------------------------------|
| Desktop Chrome   | `chromedriver`                          |
| Desktop Firefox  | `geckodriver`                           |
| Desktop Safari   | `safaridriver` (macOS only)             |
| Android emulator | `appium`, `adb`, `emulator`             |
| iOS simulator    | `appium`, `xcrun` (macOS only)          |
