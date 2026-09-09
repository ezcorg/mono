.PHONY: all clean wasmsign
.DEFAULT_GOAL := all
.DELETE_ON_ERROR:

wasmsign:
	@command -v wasmsign2 >/dev/null 2>&1 || cargo install wasmsign2-cli

# Grouped target (&:): one keygen writes both files, so losing either regenerates
# the pair. As separate rules a deleted key.public is never rebuilt while
# key.secret survives, and the build then fails on include_bytes!.
#
# Order-only (|) so the tool check never marks the keys stale. As a plain
# prerequisite it regenerates the keypair on every build, and since the public
# key is compiled into the component, that changes the plugin's identity.
key.secret key.public &: | wasmsign
	wasmsign2 keygen --public-key key.public --secret-key key.secret

all: key.secret key.public
	cargo build --release --target wasm32-wasip2
	wasmsign2 sign -i ../../../target/wasm32-wasip2/release/witmproxy_plugin_noshorts.wasm -o ../../../target/wasm32-wasip2/release/witmproxy_plugin_noshorts.signed.wasm -k key.secret
	cp ../../../target/wasm32-wasip2/release/witmproxy_plugin_noshorts.signed.wasm ../../../src/wasm/witmproxy_plugin_noshorts.signed.wasm

clean:
	cargo clean -p witmproxy-plugin-noshorts --target wasm32-wasip2
