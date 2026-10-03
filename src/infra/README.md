# infra

Declarative config for the build hosts. One flake, one directory per host.

| Path | |
|---|---|
| `flake.nix` | `nixosConfigurations.pengutron`; `packages.rig`, `packages.ci-orchestrate` |
| `hosts/pengutron/` | the Linux build host: Attic, the sccache store, Incus + rig, CI pools |
| `modules/` | `attic.nix`, `sccache-store.nix`, `incus-rig.nix`, `ci-pools.nix`, `common.nix` |
| `ci/guest/` | the CI VM image (its own flake, on rig's base) |
| `ci/orchestrate.sh` | one fresh VM per job; the host side of a pool |
| `sccache-secrets.sh`, `sccache-setup.sh` | the sccache store's secrets, and its one-time setup on pengutron |
| `signing-secrets.sh` | release signing secrets: into `secrets/release.yaml`, and from there to GitHub |
| `secrets/` | sops-encrypted; `.sops.yaml` says who can read them |

## How CI runs on pengutron

Each pool (`services.ci-pools.pools.<name>`) is a systemd service that keeps
one rig VM booted and registered with the ezcorg organization as a single-use
runner, so any ezcorg repository's jobs can land on it. The VM
runs one job, powers off, and is deleted; a fresh clone replaces it. rig's
isolation holds: the VM has no route to the host or the LAN. The services it
needs sit at fixed ports on its own 127.0.0.1, relayed over vsock: Attic at
17080, the sccache store at 17090 (`hostServices` in `modules/ci-pools.nix`
and the image's half in `ci/guest/guest.nix`).

Untrusted pools (`linux`, `linux-2`, `linux-3`: labels `nix`, `linux-vm`)
hold a pull-only Attic token and a read-only sccache key; the trusted one
(`linux-trusted`: `nix`, `linux-vm-trusted`, and bigger) may write both.
Point pull-request jobs at the first and main-branch and release jobs at the
second, so nothing untrusted can write to a cache.

The only GitHub-specific piece is one API call in `orchestrate.sh`.

Things that are easy to get wrong, all handled in the config but worth knowing:

- Just-in-time runners carry only the labels we give them; GitHub does not add
  `self-hosted`. Target `runs-on: [nix, linux-vm]`, not `self-hosted`.
- The runners join the org's Default runner group. Public repositories (mono
  is one) can use them only while that group allows public repositories:
  `gh api -X PATCH orgs/ezcorg/actions/runner-groups/1 -F allows_public_repositories=true`.
  Any workflow in the org can ask for any label (GitHub Free has that one
  group), so the trusted pools enforce who they serve themselves: a job-started
  hook (`ci/guest/job-gate.sh`, the pools' `trustedRepos`) fails a job before
  its first step unless it comes from ezcorg/mono or ezcorg/dij and from
  `main` (a push, or a manual run of `main`) or a pushed tag. Pull requests,
  other branches and other repositories get the pull-request pools only.
- One host-side vsock listener per service serves every VM, which is why the
  relays are systemd units here rather than a `rig forward` per VM (rig keys
  that listener on the port, so two forwards of one port collide). Any VM on
  the host can connect; Attic and Garage authenticate. The ports are uncommon
  on purpose: in a guest the relay holds them, and jobs want 8080 for
  themselves. A `rig forward` of 17080 or 17090 would collide with the relays.
- Under rig's ACL a NixOS host drops guest DHCP unless DHCP is marked notrack
  before bridge conntrack runs; `modules/incus-rig.nix` has the rule and the
  reasoning, and rig's runbook now documents it.
- After changing `ci/guest/`, rebuild the image (`rig image build --flake
  ./ci/guest --alias ci-guest`) and recycle the pools' current VMs with
  `rig stop <vm>`; each pool replaces its VM and sweeps the old registration.
- A changed orchestrator or secret takes effect at the next
  `nixos-rebuild switch`, which restarts the pool services.

## Workflows that use the pools

| Workflow | Pool | What |
|---|---|---|
| `pr-tests.yml` | `linux-vm` | per-project tests on pull requests; fork PRs wait for approval |
| `witmproxy.yml` (binaries) | `linux-vm-trusted`, `macos-vm-trusted` | release binaries; Linux is zig-linked against glibc 2.28 so it runs anywhere; pushes the dev shell closure to Attic |
| `infra-smoke.yml` | `linux-vm`, `macos-vm` | one tiny job per pool, on demand |

Other ezcorg repositories use the same labels: ezcorg/dij's `ci.yml` and
`release.yml` (with its own flake's dev shell).

Every job enters the workspace dev shell (`flake.nix` at the repo root) with
`nix develop -c …`; the VMs carry nothing else. Hosted GitHub runners remain
for anything else (crates.io publish, the plugin releases, Windows).

## Caches a job can use

- **Attic** at `127.0.0.1:17080`, already a substituter for nix in every
  guest, ranked above cache.nixos.org. A trusted job pushes its dev shell's
  whole closure, paths cache.nixos.org also has included, so the next guest
  gets all of it from here: `nix develop --profile .ci-shell -c true &&
  attic push --ignore-upstream-cache-filter ci:mono .ci-shell`.
  Attic advertises `127.0.0.1:17080` as its endpoint, true on pengutron and in
  every guest; from elsewhere, `ssh -L 17080:127.0.0.1:17080 pengutron`.
- **sccache's store** (Garage, `modules/sccache-store.nix`) at
  `127.0.0.1:17090`. Jobs find its address and their pool's key in their
  environment (`SCCACHE_*`, `AWS_*`); the untrusted pools' key is read-only,
  and Garage enforces it whatever the job asks for. A job opts in with
  `RUSTC_WRAPPER=sccache`, and only once `sccache --start-server` succeeds:
  sccache refuses to start when its store is unreachable, and every compile
  through it would then fail. Objects expire 30 days after they are written;
  a quota caps the bucket at 150 GiB.

## Deploying a host

`src/infra/deploy.sh pengutron` or `… galatron`: copies this directory to the
host and switches there. The hosts keep no checkout of the monorepo.

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
   Create the cache once, with a short-lived admin token, ranked above
   cache.nixos.org (priority 40; lower wins) so guests take from it what it
   has:
   ```bash
   attic login admin http://127.0.0.1:17080 "$(sudo atticd-atticadm make-token --sub admin \
     --validity 10m --pull mono --create-cache mono --configure-cache mono --configure-cache-retention mono)"
   attic cache create admin:mono --priority 30
   ```
   (An existing cache: `attic cache configure admin:mono --priority 30`. It
   always sends a retention setting too, hence `--configure-cache-retention`.)
   Jobs pull from it automatically; trusted jobs push (see "Caches a job can
   use").
5. Put a GitHub token that can create JIT runner configs for the org
   (fine-grained, resource owner `ezcorg`: Organization permissions →
   Self-hosted runners, read and write; no repository permissions) in
   `secrets/pengutron.yaml` under `github/runner-pat`.
6. The sccache store. Before the switch that enables it, generate its
   secrets into `secrets/pengutron.yaml` with `./sccache-secrets.sh` (where
   sops can decrypt; it leaves secrets that exist alone). After the switch,
   run `~/infra/sccache-setup.sh` on pengutron: a one-node Garage layout, the
   `sccache` bucket with a 150 GiB quota, the two keys from `/run/secrets`
   with read-only and read-write access, and a rule expiring objects 30 days
   after they were written (Garage evicts nothing itself; at its quota the
   cache would only stop growing). Both scripts are safe to run again.
7. Switch again; `systemctl status ci-pool-linux` should show a VM starting.

## Release signing

`secrets/release.yaml` holds what release workflows sign with, encrypted to
the operator's key alone: no host needs it. It is the source of truth; the
GitHub secrets the workflows read are copies, made by `signing-secrets.sh`.

```bash
./signing-secrets.sh apple DeveloperID.p12 AuthKey_<KEYID>.p8 <KEYID> <ISSUER>   # asks for the .p12's password
./signing-secrets.sh minisign ../../../dij/minisign.pub    # once; writes the public key for dij to commit
./signing-secrets.sh push                                   # to ezcorg/dij; other repositories as arguments
```

The `.p12` is the Developer ID Application certificate with its private key,
exported from Keychain Access; the `.p8` an App Store Connect API key (Team
key, Developer access), with its key and issuer IDs. Once stored, the
exported files can go. Rotating means storing the new ones and pushing again.

## Secrets

On macOS, export `SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt` first (sops looks in `~/Library/Application Support` by default).
`sops secrets/pengutron.yaml` edits in place. Adding a host: put its
`ssh-to-age` key in `.sops.yaml` and run `sops updatekeys`.

## Rotating secrets

| Secret | Where | Expires |
|---|---|---|
| `github/runner-pat` | `secrets/pengutron.yaml` | when set at creation (fine-grained, at most a year) |
| `attic/token-ci`, `attic/token-ci-trusted` | `secrets/pengutron.yaml` | a year after minting (`--validity 1y`) |
| `attic/env` (Attic's signing secret) | `secrets/pengutron.yaml` | never; on compromise |
| `sccache/key-ro`, `sccache/key-rw`, `garage/env` | `secrets/pengutron.yaml` | never; on compromise |
| Developer ID certificate, notary key, minisign key | `secrets/release.yaml` | certificate: five years; the Apple Developer membership: yearly |
| age keys (operator, hosts) | `.sops.yaml` | never; on loss or compromise |

Note the dates as you mint things: nothing here warns before a token
expires. An expired runner token shows as `could not get a JIT runner
config` in a pool's log (`journalctl -u ci-pool-linux`, or
`~/Library/Logs/ci-pool-macos.log` on galatron) and no jobs run; an
expired Attic token as `attic: cache not configured` in jobs, which then
fetch from cache.nixos.org.

What takes a new value when: on pengutron a changed secret restarts the
pools that load it (`restartUnits`), but not `atticd` or `garage`, which
need `sudo systemctl restart`. On galatron each pool's orchestrator reads
its tokens once at start, so after `deploy.sh galatron`:
`launchctl kickstart -k gui/$(id -u)/org.nixos.ci-pool-macos` and the same
for `org.nixos.ci-pool-macos-trusted`.

- **Runner token.** Regenerate it (github.com/settings/personal-access-tokens;
  same permissions, a new value, and approval again if ezcorg requires it),
  replace `github/runner-pat` with `sops secrets/pengutron.yaml`, deploy
  both hosts and kick galatron's pools.
- **Attic client tokens.** Mint new ones (first-time setup, step 4), replace
  them in `secrets/pengutron.yaml`, deploy both hosts and kick galatron's
  pools. An old token stays valid until it expires: Attic cannot revoke one
  token. To revoke them all at once, rotate `attic/env`.
- **`attic/env`.** Set `ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64=$(openssl rand
  64 | base64 | tr -d '\n')`, deploy pengutron, `sudo systemctl restart
  atticd`. Every token is now invalid: mint the client tokens again, as
  above.
- **sccache keys.** Remove the old one from sops (`sops unset
  secrets/pengutron.yaml '["sccache"]["key-ro"]'`, and/or `key-rw`), run
  `./sccache-secrets.sh` (it generates what is missing), deploy both hosts
  and kick galatron's pools, then on pengutron `sudo garage key delete --yes
  sccache-ro` (and/or `sccache-rw`) and `~/infra/sccache-setup.sh`, which
  imports the new key. In between, jobs build without sccache.
- **`garage/env`.** A new `GARAGE_RPC_SECRET`, deploy pengutron, `sudo
  systemctl restart garage`. One node, so nothing else changes.
- **Developer ID certificate, notary key.** Before the certificate expires
  (or after revoking it at developer.apple.com, or the key in App Store
  Connect): `./signing-secrets.sh apple …` with the new files, which
  replaces the old values, then `./signing-secrets.sh push`.
- **minisign key.** `sops unset secrets/release.yaml '["minisign"]'`, then
  `./signing-secrets.sh minisign <dij checkout>/minisign.pub` and `push`, and
  commit the new `minisign.pub` in dij. Releases signed before verify only
  with the old public key; keep it with them (their release notes).
- **Age keys.** Back up the operator's key (`~/.config/sops/age/keys.txt`):
  `secrets/release.yaml` is encrypted to it alone. A reinstalled host gets a
  new key from its SSH host key: replace it in `.sops.yaml` and run `sops
  updatekeys secrets/pengutron.yaml`. Dropping a compromised key the same way
  stops it reading new versions, not what it already read: rotate every
  secret in that file too.
- **galatron's guest SSH key** (`~/.ssh/ci-guest`): delete it and rebuild the
  image (`nix run .#ci-macos-image` makes a new one).
