.phony=all clean

key.secret key.public:
	wasmsign2 keygen --public-key key.public --secret-key key.secret

all: key.secret key.public
	cargo build --release --target wasm32-wasip2
	wasmsign2 sign -i ../../../target/wasm32-wasip2/release/wasm_test_component.wasm -o ../../../target/wasm32-wasip2/release/wasm_test_component.signed.wasm -k key.secret

clean:
	cargo clean --target wasm32-wasip2