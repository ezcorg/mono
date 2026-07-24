# Dev container for witmproxy that reuses src/apps/witmproxy/flake.nix as the
# single source of truth for the toolchain and native deps.
#
# Nix is installed in SINGLE-USER mode (no daemon), which is the most reliable
# setup inside a container. Everything else — the pinned nightly Rust, SQLCipher
# build deps, wasm tooling — comes from `nix develop`, not from apt.
FROM mcr.microsoft.com/devcontainers/base:bookworm

# /nix is owned by the runtime user so the single-user installer needs no root
# and no daemon.
RUN mkdir -m 0755 /nix && chown vscode /nix

USER vscode

# Single-user Nix + flakes.
RUN curl --proto '=https' --tlsv1.2 -sSf -L https://nixos.org/nix/install | sh -s -- --no-daemon \
    && mkdir -p /home/vscode/.config/nix \
    && echo 'experimental-features = nix-command flakes' > /home/vscode/.config/nix/nix.conf

ENV PATH="/home/vscode/.nix-profile/bin:${PATH}"

# direnv + nix-direnv so a terminal opened in src/apps/witmproxy (and thus
# rust-analyzer, via the mkhl.direnv extension) auto-loads the flake dev shell.
RUN nix profile install nixpkgs#direnv nixpkgs#nix-direnv \
    && mkdir -p /home/vscode/.config/direnv \
    && echo "source $(nix eval --raw nixpkgs#nix-direnv)/share/nix-direnv/direnvrc" \
       > /home/vscode/.config/direnv/direnvrc \
    && echo 'eval "$(direnv hook bash)"' >> /home/vscode/.bashrc

USER root
