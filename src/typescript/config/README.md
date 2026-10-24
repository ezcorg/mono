# `@joinezco/config`

Settings as files. A schema says what can be chosen and what it is by
default; files in a known folder of any `@joinezco/storage` filesystem
hold what was chosen, one file per scope, YAML by default; a `Config`
reads them, lays them over one another and over the defaults, watches
them, and writes a change back where it belongs. No DOM, no editor.

```ts
import { Config, fromZod, z, deviceId } from '@joinezco/config'

const schema = fromZod(
    z.object({
        comments: z.object({
            openOnClick: z.boolean().default(false).describe('A click on commented text looks at its comment.'),
            step: z.number().min(0).max(64).default(32),
        }).meta({ title: 'Comments' }),
    }),
    { title: 'Editor settings' },
)

const config = await Config.open({ fs, schema, user: 'theo', device: deviceId(), instance: 'notes' })
config.get('comments.step')              // 32, or what a file says
await config.set('comments.step', 40)    // .settings/theo/global.yaml
await config.set('comments.step', 48, 'device')
config.subscribe(() => render(config.get()))
```

## Files and scopes

```
.settings/schema.json                   the schema, for other editors
.settings/<user>/global.yaml            everywhere this user opens the vault
.settings/<user>/devices/<device>.yaml  this device
.settings/<user>/instances/<id>.yaml    this editor instance (the host names it)
```

Without a `user` the files sit under the folder itself. `root` moves the
folder; `format: 'json'` writes JSON (a file keeps the kind it was made
in; `.yml` is read too). A more specific scope wins over a less specific
one; `chosen(path)` is the files' value alone, for a host whose own option
is the default. A value a file gets wrong (the wrong type, out of range,
not among the choices) is left out and reported by `problems()`. A YAML
file keeps its comments and order through a `set`.

The folder is watched (`fs.watch`), so a change made in another editor,
by hand, or by a sync of the folder reaches every reader; `reload()` is
for a filesystem that cannot watch.

## Another user's settings

`Config.open({ user: 'theo', of: 'alice' })` reads alice's; a `set` throws
`NotPermitted` unless alice's global file grants it:

```yaml
access:
  editors: [theo]   # or "*"
```

`access` is a reserved setting the schema gets for free. This is a
convention for well-behaved clients, not a security boundary: the check
and the `user` name live in the client, and no filesystem behind the
store knows what a user is. Enforcing it against a client that does not
cooperate is the storage or sync layer's: a server that authenticates
writers, or replicas that verify each version's signature against the
owner's key and the keys the owner's own file grants. The user, device,
instance and folder names are checked to be plain names, so a host that
takes one from a URL cannot reach past the folder.

## For a UI

`fieldsOf(schema)` (and `config.fields()`) lists the settings a UI can
show: a switch, a choice, a number or text, with its group, label,
description, default and bounds. Objects are groups; arrays are left to
the file.
