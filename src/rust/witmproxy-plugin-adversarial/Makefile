.PHONY: all clean
.DEFAULT_GOAL := all

# This component is deliberately hostile and is NOT signed. It declares an empty
# public key, which the production load path rejects outright, so it can only be
# loaded through the test-only registration helper. It must never be published.
all:
	cargo build --release --target wasm32-wasip2 -p witmproxy-plugin-adversarial

clean:
	cargo clean --target wasm32-wasip2
