.phony=all clean wasmsign
.DEFAULT_GOAL := all

wasmsign:
	cargo install wasmsign2-cli

key.secret: wasmsign
	wasmsign2 keygen --public-key key.public --secret-key key.secret

key.public: key.secret
	@echo "Public key generated alongside secret key"

all: key.secret key.public
	cargo build --release --target wasm32-wasip2
	wasmsign2 sign -i ../../../target/wasm32-wasip2/release/witmproxy_plugin_noop.wasm -o ../../../target/wasm32-wasip2/release/witmproxy_plugin_noop.signed.wasm -k key.secret

clean:
	cargo clean --target wasm32-wasip2