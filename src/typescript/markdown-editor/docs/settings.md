# Settings

The editor makes choices: where comments show, how far a card steps out,
what face the note is set in, whether a note's properties fold. Each is
the editor's preference over a range of possibilities, and a reader may
prefer another. Settings are how a reader says so, and how a host ships
its own defaults: a schema of what can be chosen, and files that hold what
was.

## The shape

`@joinezco/config` (`src/typescript/config`) is the library; it knows no
DOM and no editor, only a schema and a filesystem.

- **The schema** is written in zod (`fromZod`) or handed in as JSON Schema
  (draft 7). It gives every setting its type, its default, a title and a
  line saying what it does. From it come the defaults, the check a file's
  values go through, the fields a generated UI shows (`fieldsOf`), and
  `schema.json` beside the files, so another editor validates them too.
- **The files** live under a known folder of the vault, `.settings` by
  default (`root`), one file per scope, YAML by default (`format: 'json'`
  for JSON; a file keeps the kind it was made in):

      .settings/schema.json
      .settings/<user>/global.yaml
      .settings/<user>/devices/<device>.yaml
      .settings/<user>/instances/<instance>.yaml

  Without a user (a vault of one's own) the files sit right under the
  folder. A `set` from the editor keeps a YAML file's comments and order
  (the `yaml` library's document model); a new file names the schema for
  editors that read the `yaml-language-server` comment.
- **The scopes**, least specific first: *global* (everywhere this user
  opens the vault), *device* (this device, named by `deviceId()`, a short
  id kept in the browser, or by the host), *instance* (this editor
  instance, named by the host: `settings: { instance: 'notes-pane' }`). A
  value in a more specific scope wins; any over the default. What a file
  gets wrong (a string for a number, a value out of range) is left out
  and reported (`problems()`), never read.
- **Live**: the folder is watched. An edit in any editor, by hand, or a
  sync that brings another device's write, reaches every reader
  (`subscribe`). A `set` is there to read at once and in the file soon
  after.

## In the editor

`src/lib/editor/settings.ts` holds the editor's schema and the `Settings`
extension; `settingsOf(editor)` is how a feature reads a setting. The
extension opens a `Config` over the editor's filesystem (the host's
`settings.fs`, else the editor's own; in the browser's localStorage when
there is none), as the comments' author, on this device, in the instance
the host names.

Two reading patterns:

- `get(path)`: the files laid over the schema's default. For a setting
  whose default is the editor's (`comments.step`, `editor.font`).
- `chosen(path) ?? option`: the files' value when there is one, else the
  host's option. For a setting whose default the host gives
  (`comments.openOnClick`, the panel's layout).

Every setting is reachable three ways, all of them the same files:

1. **The toolbar's `settings` mode** (type `settings`, or choose Settings):
   the schema's fields as entries, a switch flipped on Enter, a choice
   cycled, a value typed; first the scope a change goes to (the device by
   default, so a choice made on a laptop stays the laptop's), last the
   file to open.
2. **The file as code**: `Open the settings file` loads the scope's file
   in the editor's code view, where `codemirror-json-schema` (Theo's fork,
   from the clone beside the monorepo until it is published) gives
   completion, checking and hover from the schema.
3. **The chrome itself**: the panel's switches ("Anchor comments to
   text", "Show resolved", "Hide comments panel"), the front matter's
   "Collapse when not editing". These write the device scope.

## The rule for new work

A feature that picks one of several reasonable behaviours declares a
setting for it: add it to `EditorSettingsSchema` with a default and a
line of description, read it where the choice is made (`settingsOf`),
and let the host's option be the default where the host gives one
(`chosen(path) ?? option`). Not every option is a setting: what only a
host can know (its filesystem, its identity, where a panel mounts) stays
an option. What a reader might reasonably want otherwise is a setting.

## Several users, one vault

Settings are per user: `.settings/<user>/`. One user's `Config` only ever
derives paths under that user's folder, and `Config.open({ of: 'alice' })`
reads another's; writing them is refused (`NotPermitted`) unless alice's
own global file says `access: { editors: ['theo'] }` (or `'*'`). That is
the editor's side of it. In a vault shared between people, the storage
layer is where it is enforced: the version log signs each write
(`Signer` in `@joinezco/storage`), and a peer or server applying a write
under `.settings/<user>/` checks the signer is that user, or one the
user's own global file lists.

## Devices in sync

The user asked what device synchronisation would look like. The settings
design assumes it is a shared filesystem: the vault's files replicated
between a person's devices (and between collaborators), each device
writing its own files and reading the others'. That fits what is here:

- The `VersionLog` already gives each file a history with parents, so a
  replica can tell a new version from a stale one and keep a conflict
  copy rather than lose a write; most settings files have one writer (the
  device scope is a device's own; the global scope, one person's), so
  conflicts are rare and last-writer-wins on a file is acceptable.
- Peer-to-peer: devices exchange version-log entries and blobs over a
  transport (WebRTC between browsers; the icanhaz daemon or wRPC where
  there is a host), each entry signed by the device's key, each device
  holding the person's keys to sign as them. No server is needed for
  correctness; one may relay for devices that are never online at once.
- The scopes map onto this directly: *global* is the file every device
  reads; *device* is the file only its device reads (it still syncs, so
  the person can see and edit a laptop's settings from a phone); *instance*
  is a host's own name and syncs likewise.
- Grants (`access.editors`) are the only cross-user write; a replica
  rejects a write to `.settings/<user>/` not signed by that user or a
  grantee.

What is not built: the transport and the replica. `@joinezco/config`
needs nothing of them; it needs the files to arrive, which `watch`
already reports.

## Not yet

- The code block's own settings (`@joinezco/codeblock`'s `settingsField`:
  line wrap, font size, line numbers) are still a CodeMirror state field,
  per block. Bridging them to a `codeblock` section of the editor's schema
  would give one place for both.
- The `file:` dependency on the fork is temporary: the published package
  replaces it, and the `optimizeDeps` entries for it in `vitest.config.ts`
  can go with it.
