# infra

Declarative config for the build hosts. One flake, one directory per host.

| Path | |
|---|---|
| `flake.nix` | `nixosConfigurations.pengutron`; `packages.rig`, `packages.ci-orchestrate` |
| `hosts/pengutron/` | the Linux build host: Attic, Incus + rig, CI pools |
| `modules/` | `attic.nix`, `incus-rig.nix`, `ci-pools.nix`, `common.nix` |
| `ci/guest/` | the CI VM image (its own flake, on rig's base) |
| `ci/orchestrate.sh` | one fresh VM per job; the host side of a pool |
| `secrets/` | sops-encrypted; `.sops.yaml` says who can read them |

## How CI runs on pengutron

Each pool (`services.ci-pools.pools.<name>`) is a systemd service that keeps
one rig VM booted and registered with GitHub as a single-use runner. The VM
runs one job, powers off, and is deleted; a fresh clone replaces it. rig's
isolation holds: the VM has no route to the host or the LAN. The Attic cache
reaches it over a vsock tunnel (`rig forward --to-guest`), not the network.

Two pools: `linux` (labels `nix`, `linux-vm`) with a pull-only Attic token,
and `linux-trusted` (`nix`, `linux-vm-trusted`) whose token may push. Point
pull-request jobs at the first and main-branch jobs at the second, so nothing
untrusted can write to the cache.

The only GitHub-specific piece is one API call in `orchestrate.sh`.

Things that are easy to get wrong, all handled in the config but worth knowing:

- Just-in-time runners carry only the labels we give them; GitHub does not add
  `self-hosted`. Target `runs-on: [nix, linux-vm]`, not `self-hosted`.
- Each pool tunnels Attic into its guests on a different port (`atticGuestPort`),
  because rig keys its host-side vsock listener on the guest port.
- Under rig's ACL a NixOS host drops guest DHCP unless DHCP is marked notrack
  before bridge conntrack runs; `modules/incus-rig.nix` has the rule and the
  reasoning, and rig's runbook now documents it.
- After changing `ci/guest/`, rebuild the image (`rig image build --flake
  ./ci/guest --alias ci-guest`) and recycle the pools' current VMs with
  `rig stop <vm>`; each pool replaces its VM and sweeps the old registration.
- A changed orchestrator or secret takes effect at the next
  `nixos-rebuild switch`, which restarts the pool services.

## galatron (macOS)

The same pool design on Tart, as a LaunchAgent under the logged-in user
(`modules/darwin/ci-pools-tart.nix`, `ci/macos/`). Peculiarities:

- Tart is a pinned Nix package built from the signed release bundle
  (`pkgs/tart.nix`); Cirrus's Homebrew tap does not load on current Homebrew.
- Anything that talks to a VM must be an Apple-signed binary. macOS's Local
  Network privacy lets `/usr/bin/ssh` reach the vmnet bridge and refuses a
  Nix-built ssh with "No route to host". The wrappers leave openssh out of
  their inputs for this reason.
- Determinate Nix on macOS 27 must be installed from a terminal with Full Disk
  Access (Terminal.app at the keyboard); SSH sessions fail on `/etc/fstab`.
- Build the image with `nix run .#ci-macos-image` on galatron; it starts from
  the `tahoe-base` Tart image and produces `ci-macos`.
- `sudo darwin-rebuild switch --flake .#galatron` applies changes.

## Applying

```bash
nix flake check ./src/infra                                  # anywhere
sudo nixos-rebuild switch --flake ./src/infra#pengutron      # on pengutron, from a checkout
```

## First-time setup on pengutron (in order)

1. `sudo nixos-rebuild switch --flake .#pengutron`, then log in again so
   `incus-admin` membership applies.
2. `rig setup` once: the isolation ACL and the `rig` profile.
3. Build the CI image: `rig image build --flake ./ci/guest --alias ci-guest`.
4. Mint Attic tokens and put them in `secrets/pengutron.yaml`
   (`sops secrets/pengutron.yaml`):
   ```bash
   sudo atticd-atticadm make-token --sub ci --validity 1y --pull mono
   sudo atticd-atticadm make-token --sub ci-trusted --validity 1y --pull mono --push mono
   ```
   Create the cache itself once, with the trusted token:
   `attic login local http://127.0.0.1:8080 <token> && attic cache create mono`.
   Jobs pull from it automatically. Nothing pushes yet: a trusted job pushes
   with `attic push ci:mono <paths>` or by running `attic watch-store ci:mono`
   for the duration of the build.
5. Put a GitHub token that can create JIT runner configs on the repo
   (fine-grained: Administration read/write on `ezcorg/mono`) in
   `secrets/pengutron.yaml` under `github/runner-pat`.
6. Switch again; `systemctl status ci-pool-linux` should show a VM starting.

## Secrets

On macOS, export `SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt` first (sops looks in `~/Library/Application Support` by default).
`sops secrets/pengutron.yaml` edits in place. Adding a host: put its
`ssh-to-age` key in `.sops.yaml` and run `sops updatekeys`.
