# Use the official Rust image as the base
FROM rust as builder

# Set the working directory
WORKDIR /usr/src/ezfilter-rs

# Copy the Cargo.toml and Cargo.lock files
COPY Cargo.toml ./

# Copy the source code
COPY src ./src

# Build the release binary
RUN cargo build --release --bin tester

# Use a smaller runtime image
FROM debian:bookworm-slim

# Install necessary dependencies
RUN apt-get update && apt-get install -y libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy the binary from the builder stage
COPY --from=builder /usr/src/ezfilter-rs/target/release/tester /usr/local/bin/tester

# Set the entrypoint
ENTRYPOINT ["tester"]