# relations-unum

Routing, syncing and clashes across unums. The TypeScript port of
[python-relations-unum](https://github.com/relations-dil/python-relations-unum), built on
[`@relations-dil/relations`](https://github.com/relations-dil/typescript-relations) and
[`@relations-dil/unifist`](https://github.com/relations-dil/typescript-relations-unifist).

A unum is one place's copy of the data. `UnumSource` is a relations source that routes each operation on a record to
the source that has it, here or in another unum, and `sync` keeps the copies in step by replaying one unum's journal in
another, recording what can't be applied as a clash instead of stopping. Source agnostic: it builds on the core
library's `Source` and the Unifist source's ids and journal, so it works over any relations source.

```bash
npm install @relations-dil/unum @relations-dil/unifist @relations-dil/relations
```

## Contents

- [The source](#the-source)
- [Routes and scribes](#routes-and-scribes)
- [Reading and writing](#reading-and-writing)
- [Sync](#sync)
- [Clashes](#clashes)
- [Differences from Python](#differences-from-python)
- [API reference](#api-reference)
- [Development](#development)

---

## The source

Make one with the name your models' `source` uses, the name of this unum, the source this unum's own data is in, and the
source of each other unum by the unum's name. Every one of them is a regular relations source made on its own:

```ts
import { UnifistModel } from '@relations-dil/unifist'
import { UnumSource } from '@relations-dil/unum'

UnifistModel.unum = 'home'

new UnumSource('unum', {
  unum: 'home',
  local: 'local',                           // the source this unum's data is in
  members: { away: 'away', cloud: 'cloud' } // the sources of the other unums
})
```

The routes, scribes, clashes and journal live in the Unifist source, `unifist` unless it's been changed on the lib.

## Routes and scribes

A `Route` says who has the data that matches, in what role (`owner`, `writer` or `reader`), and where to reach them (a
url, blank for here). A `Scribe` says where a write to the data that matches goes (`owner`, `writer` or `local`). Both
match a record's id, `identifier:model.source:unum`, on its parts, blank meaning any, and `pattern()` shows one like the
id with a `*` for any:

```ts
await new Route({ unum: 'home', model: 'owned', role: 'owner', holder: 'away' }).create()
await new Scribe({ unum: 'home', model: 'owned', to: 'owner' }).create()

new Scribe({ unum: 'home', model: 'owned', to: 'owner' }).pattern() // '*:owned.*:home'
```

`route(id)` is who has a record's data: owners, then writers, then readers, and for each role the rows that match the most
win, so what a model or a record says beats what its unum says. `scribe(id)` is the one row that says where a write goes,
the first made if some match as much, or `null`.

## Reading and writing

- **A write** goes where the scribe says: the owner, the writers in order (the next if one is down), or here.
- **A read by id** is from here if this unum holds a copy, else its owner, writers and readers in turn.
- **A query for many** is sent to every source and the results merged lazily in the order the query says, a page at a time
  (`chunk` rows, the model's if not set), a record in more than one only once, and a source that is down skipped.
  `limit` and `sort` work as they do on any model, and `overflow` says when a limit was reached.
- **`count`** is still from here.

`await source.syncing(async () => { ... })` keeps writes and reads here while the work is done, because what sync applies
is a copy.

## Sync

`apply(source, row, models)` applies another unum's journal row here by making the same write with the row's writer, so the
journal row written has the same id and the transaction is the same everywhere. It resolves to `'applied'`, `'skipped'`
(it is here already) or `'clash'`. `models(...classes)` is the lookup from a journal row's app and block to a model.

`journal(source, member)` is another unum's journal, and `sync(source, member, models)` applies what it has that this unum
does not, oldest first, and resolves to how many were applied, skipped and clashed. If the other unum can't be reached the
error is thrown, to be tried again:

```ts
import { models, sync } from '@relations-dil/unum'

await sync(source, 'away', models(Item, Owned)) // { applied: 4, skipped: 0, clash: 1 }
```

## Clashes

A row that can't be applied, because the record is not at the version it was from (`version`), is not there (`missing`),
already is (`exists`), or its model is not known (`model`), is recorded as a `Clash` with the same id as the journal row and
left alone until someone sorts it out. The system keeps going when one piece breaks.

`update` and `delete` of a record that clashed are refused with a `ClashError`, by id or by a query, unless the write says
`{ force: true }`, and not while syncing. Reads are not refused, the app decides. `clashed(id)` is a record's clashes.

```ts
await item.update({ force: true })
```

## Differences from Python

| | Python | Here | Why |
| --- | --- | --- | --- |
| **Calls** | Synchronous | `async` | The sources are |
| **The source** | `Source` | `UnumSource` | Like `RestSource` and `LocalSource` |
| **`with source.syncing():`** | A context manager | `await source.syncing(async () => { ... })` | No context managers across `await` |
| **`force=True`** | A keyword | `update({ force: true })` | No keyword arguments (needs unifist 0.1.1, which forwards the options) |
| **`stream` and `select`** | Generators | Async generators | The reads are async |
| **`models()`** | Keyed by `(source, model)` | Keyed `'source.model'` | A source is a dns label and a model's name has no `.` |
| **Journal rows in `apply`** | A value in a row is the same if `==` | The same if their JSON is | JS has no deep `==` |

## API reference

`UnumSource` (`syncing()`, `sources()`, `attempt()`, `init()`, `write()`, `create()`, `stream()`, `select()`, `retrieve()`,
`refuse()`, `update()`, `delete()`, `count()`), `Clash`, `ClashError`, `Route`, `Scribe`, `Matching` (their `specificity()` and
`pattern()`), `clashed()`, `route()`, `scribe()`, `models()`, `apply()`, `journal()` and `sync()`.

## Development

Nothing needs installing but Docker and make. `make` on its own lists every target, and the usual ones are
`make build`, `make test` (100% coverage), `make lint` and `make setup`.

### Releasing

`VERSION` is the one place the version is set. The work is in `scripts/`, one script per target.

```bash
make new                  # on the ticket branch you're on: next version, VERSION, package.json, changelog
make release-check        # where the release is up to, and what would stop it
make release              # from main: the checks, npm, a clean install from it, the tag
make test-release         # tests the scripts against a throwaway repo and a fake registry
```

`make release` does only what's left, so it can be run again after a failure, and once the version is out and tagged
it does nothing. It needs `~/.npmrc` with a token that can publish. The Jenkins build runs it on `main`, so merging a
pull request with an unreleased `VERSION` releases it.

A dependent can test against a commit before a release by pinning it, `"@relations-dil/unum":
"git+https://github.com/relations-dil/typescript-relations-unum.git#<hash>"`: npm builds the package on install
(`prepare`). `make release-check` refuses to release while a dependency is a pin like that, so it becomes a version
again first.

## License

MIT
