/**
 * Ported from python-relations-unum test/test_relations_unum.py
 *
 * Translation notes:
 *
 * - Everything that touches a source is async, so every write and read is awaited.
 * - Python's keyword arguments become named values (a trailing object), and `writer` and `force` are the options,
 *   the first argument of `create`, `update` and `delete`: `update({ force: true })`.
 * - The source is `UnumSource`, like `RestSource` and `LocalSource`.
 * - `with source.syncing():` is `await source.syncing(async () => { ... })`.
 * - `stream` is an async generator, read with `next()` and `for await`.
 * - `models()` is keyed `source.name`, a source being a dns label and a model's name having no `.`.
 * - `source.data` holds Maps, so it is flattened where Python compares a dict.
 * - Setting values on a one-mode query needs it retrieved first (`await ... .retrieve()`).
 */

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { MockSource, SourceError, clear, fields, int, str } from '@relations-dil/relations'
import { Journal, UnifistBase, UnifistModel } from '@relations-dil/unifist'

import { Clash, ClashError, Route, Scribe, UnumSource, apply, clashed, journal, models, route, scribe, sync } from '../src/index.js'

// --------------------------------------------------------------------------- helpers

function keys(records: Map<any, any>): any[] {
  return [...records.keys()].sort()
}

async function rejectsWith(work: () => Promise<any>, name: string, message: RegExp): Promise<void> {
  await assert.rejects(work, (error: any) => {
    assert.equal(error.name, name)
    assert.match(error.message, message)
    return true
  })
}

class Base extends UnifistModel {
  static source = 'unum'
}

class Item extends fields({ id: str, version: { kind: int, default: 1 }, name: str }, Base) {}

class Owned extends fields({ id: str, version: { kind: int, default: 1 }, name: str }, Base) {}

class Mine extends fields({ id: str, version: { kind: int, default: 1 }, name: str }, Base) {}

class Team extends fields({ id: str, version: { kind: int, default: 1 }, name: str }, Base) {}

class Copied extends fields({ id: str, version: { kind: int, default: 1 }, name: str }, Base) {}

// --------------------------------------------------------------------------- module

describe('module', () => {
  let unifist: MockSource

  beforeEach(() => {
    clear()
    unifist = new MockSource('unifist')
  })

  it('test_clashed', async () => {
    // The clashes a record has, any version and writer, in the clash's id, version:identifier:resource:owner:writer

    assert.deepEqual(await clashed('1:item.unum:home'), [])

    await new Clash({ id: '2:1:item.unum:home:away', what: { error: 'version' } }).create()
    await new Clash({ id: '3:1:item.unum:home:cloud', what: { error: 'version' } }).create()
    await new Clash({ id: '2:11:item.unum:home:away', what: { error: 'missing' } }).create()

    assert.deepEqual(
      (await clashed('1:item.unum:home')).map((clash: any) => clash.id),
      ['2:1:item.unum:home:away', '3:1:item.unum:home:cloud']
    )
    assert.deepEqual(
      (await clashed('11:item.unum:home')).map((clash: any) => clash.id),
      ['2:11:item.unum:home:away']
    )
    assert.deepEqual(await clashed('2:item.unum:home'), [])
    assert.deepEqual(await clashed('1:item.unum:away'), [])
    assert.equal(unifist.data.clash.size, 3)
  })

  it('test_journal', () => {
    // Another unum's journal, the same as the one here but in the source that unum's records are in

    const source = new UnumSource('unum', { unum: 'home', local: 'local', members: { away: 'away' } })
    const member: any = journal(source, 'away')

    const without = (definition: any) => Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'source'))

    assert.equal(member.source, 'away')
    assert.equal(member.thy().NAME, 'journal')
    assert.deepEqual(without(member.thy().define()), without(Journal.thy().define()))
    assert.equal(Journal.source, 'unifist')
  })

  it('test_models', () => {
    // The models sync can apply, by the app (source) and block (model) a journal row has

    assert.deepEqual(models(Item, Owned), { 'unum.item': Item, 'unum.owned': Owned })
    assert.deepEqual(models(), {})
  })

  it('test_route', async () => {
    // Nothing is nothing

    assert.deepEqual(await route('42:item.local:home'), [])

    // Whoever has a record's data in whatever role, from rows that match it. Blank matches anything, and for each role
    // the rows that match the most win, so a model's or a record's own say beats its unum's

    await new Route({ unum: 'home', role: 'owner', holder: 'away', url: 'https://away' }).create()
    await new Route({ unum: 'home', model: 'item', role: 'writer', holder: 'home' }).create()
    await new Route({ unum: 'home', model: 'item', identifier: '42', role: 'reader', holder: 'cloud', url: 'https://cloud' }).create()
    await new Route({ unum: 'home', model: 'item', role: 'reader', holder: 'attic' }).create()

    const holders = async (id: string) => (await route(id)).map((row: any) => [row.role, row.holder])

    assert.deepEqual(await holders('42:item.local:home'), [['owner', 'away'], ['writer', 'home'], ['reader', 'cloud']])
    assert.deepEqual(await holders('7:item.local:home'), [['owner', 'away'], ['writer', 'home'], ['reader', 'attic']])
    assert.deepEqual(await holders('7:thing.local:home'), [['owner', 'away']])
    assert.deepEqual(await holders('7:item.local:cloud'), [])

    // And where to reach them

    assert.equal((await route('42:item.local:home'))[2].url, 'https://cloud')
    assert.equal((await route('42:item.local:home'))[1].url, '')
  })

  it('test_scribe', async () => {
    // Nothing is nothing

    assert.equal(await scribe('42:item.local:home'), null)

    // Where a write goes, from the one row that matches the most, blank matching anything

    await new Scribe({ to: 'local' }).create()
    await new Scribe({ unum: 'home', to: 'owner' }).create()
    await new Scribe({ unum: 'home', model: 'item', to: 'writer' }).create()
    await new Scribe({ unum: 'home', model: 'item', identifier: '42', to: 'local' }).create()

    assert.equal(((await scribe('42:item.local:home')) as any).to, 'local')
    assert.equal(((await scribe('7:item.local:home')) as any).to, 'writer')
    assert.equal(((await scribe('7:thing.local:home')) as any).to, 'owner')
    assert.equal(((await scribe('7:item.local:cloud')) as any).to, 'local')

    // Rows that match as much as each other, the first made wins

    await new Scribe({ unum: 'home', source: 'local', to: 'owner' }).create()
    await new Scribe({ unum: 'home', source: 'local', model: 'thing', to: 'local' }).create()

    assert.equal(((await scribe('7:item.local:home')) as any).to, 'writer')
    assert.equal(((await scribe('7:other.local:home')) as any).to, 'owner')
    assert.equal(((await scribe('7:thing.local:home')) as any).to, 'local')
    assert.equal(((await scribe('7:other.remote:home')) as any).to, 'owner')
  })
})

// --------------------------------------------------------------------------- the tables

describe('Clash', () => {
  it('test_define', () => {
    const definition = Clash.thy().define()
    const byName = Object.fromEntries(definition.fields.map((field: any) => [field.name, field]))

    // In the Unifist source with the journal, and with the same id as the journal row it's about,
    // version:identifier:resource:owner:writer, so the two go together without another field

    assert.ok(Clash.prototype instanceof UnifistBase)
    assert.equal(Clash.source, UnifistBase.source)
    assert.equal(definition.name, 'clash')
    assert.equal(definition.id, 'id')
    assert.deepEqual(
      definition.fields.map((field: any) => field.name),
      ['id', 'what']
    )
    assert.deepEqual(
      definition.fields.map((field: any) => field.kind),
      ['str', 'dict']
    )
    assert.deepEqual(definition.unique, {})
    assert.equal(byName.what.none, false)

    // Made with the id of the journal row, and what's wrong with it

    const clash: any = new Clash({ id: '2:42:item.local:away:away', what: { error: 'version' } })

    assert.equal(clash.id, '2:42:item.local:away:away')
    assert.deepEqual(clash.what, { error: 'version' })
  })

  it('test_clash_error', () => {
    const error = new ClashError('unittest', 'clashed')

    assert.equal(error.name, 'ClashError')
    assert.equal(error.detail, 'clashed')
    assert.ok(error instanceof Error)
  })
})

describe('Route', () => {
  it('test_define', () => {
    const definition = Route.thy().define()
    const byName = Object.fromEntries(definition.fields.map((field: any) => [field.name, field]))

    // Who has the data, in what role and where, matched on the parts of a record's id, in the id's order, blank being anything

    assert.ok(Route.prototype instanceof UnifistBase)
    assert.equal(definition.name, 'route')
    assert.equal(definition.id, 'id')
    assert.deepEqual(
      definition.fields.map((field: any) => field.name),
      ['id', 'identifier', 'model', 'source', 'unum', 'role', 'holder', 'url']
    )

    for (const name of ['identifier', 'model', 'source', 'unum', 'url']) {
      assert.equal(byName[name].kind, 'str')
      assert.equal(byName[name].default, '')
      assert.equal(byName[name].none, false)
    }

    assert.deepEqual(byName.role.options, ['owner', 'writer', 'reader'])
    assert.equal(byName.holder.none, false)
    assert.deepEqual(definition.unique, {
      'identifier-model-source-unum-role-holder': ['identifier', 'model', 'source', 'unum', 'role', 'holder']
    })
  })

  it('test_pattern', () => {
    // Shown like a record's id, with a * for anything, though a blank is what's kept

    assert.equal((new Route({ unum: 'home', role: 'owner', holder: 'away' }) as any).pattern(), '*:*.*:home')
    assert.equal(
      (new Route({ unum: 'home', model: 'item', identifier: '42', role: 'reader', holder: 'a' }) as any).pattern(),
      '42:item.*:home'
    )
    assert.equal((new Route({ role: 'owner', holder: 'away' }) as any).pattern(), '*:*.*:*')
    assert.equal(
      (new Route({ unum: 'home', source: 'local', model: 'item', identifier: '7', role: 'owner', holder: 'a' }) as any).pattern(),
      '7:item.local:home'
    )
  })

  it('test_specificity', () => {
    // How many of the parts are set

    assert.equal((new Route({ role: 'owner', holder: 'away' }) as any).specificity(), 0)
    assert.equal((new Route({ unum: 'home', role: 'owner', holder: 'away' }) as any).specificity(), 1)
    assert.equal(
      (new Route({ unum: 'home', source: 'local', model: 'item', identifier: '7', role: 'owner', holder: 'a' }) as any).specificity(),
      4
    )
  })
})

describe('Scribe', () => {
  it('test_define', () => {
    const definition = Scribe.thy().define()
    const byName = Object.fromEntries(definition.fields.map((field: any) => [field.name, field]))

    // Where a write goes, matched the same way, one row for each match

    assert.ok(Scribe.prototype instanceof UnifistBase)
    assert.equal(definition.name, 'scribe')
    assert.equal(definition.id, 'id')
    assert.deepEqual(
      definition.fields.map((field: any) => field.name),
      ['id', 'identifier', 'model', 'source', 'unum', 'to']
    )

    for (const name of ['identifier', 'model', 'source', 'unum']) {
      assert.equal(byName[name].kind, 'str')
      assert.equal(byName[name].default, '')
      assert.equal(byName[name].none, false)
    }

    assert.deepEqual(byName.to.options, ['owner', 'writer', 'local'])
    assert.deepEqual(definition.unique, { 'identifier-model-source-unum': ['identifier', 'model', 'source', 'unum'] })
  })

  it('test_pattern', () => {
    assert.equal((new Scribe({ unum: 'home', to: 'owner' }) as any).pattern(), '*:*.*:home')
    assert.equal((new Scribe({ unum: 'home', model: 'item', identifier: '42', to: 'local' }) as any).pattern(), '42:item.*:home')
    assert.equal((new Scribe({ to: 'local' }) as any).pattern(), '*:*.*:*')
  })
})

// --------------------------------------------------------------------------- the source

describe('UnumSource', () => {
  let local: MockSource
  let away: MockSource
  let cloud: MockSource
  let source: UnumSource

  beforeEach(async () => {
    clear()

    new MockSource('unifist')

    local = new MockSource('local')
    away = new MockSource('away')
    cloud = new MockSource('cloud')

    source = new UnumSource('unum', { unum: 'home', local: 'local', members: { away: 'away', cloud: 'cloud' } })

    UnifistModel.unum = 'home'

    // Item has no rows, so it's written here. Owned is written to its owner, who's away. Mine is the same
    // but the owner is this unum. Team is written to its writers, away first, then cloud. Copied is owned away
    // but this unum reads it, so a copy here, from sync, is read before the owner's

    await new Scribe({ unum: 'home', model: 'owned', to: 'owner' }).create()
    await new Route({ unum: 'home', model: 'owned', role: 'owner', holder: 'away' }).create()
    await new Scribe({ unum: 'home', model: 'mine', to: 'owner' }).create()
    await new Route({ unum: 'home', model: 'mine', role: 'owner', holder: 'home' }).create()
    await new Scribe({ unum: 'home', model: 'team', to: 'writer' }).create()
    await new Route({ unum: 'home', model: 'team', role: 'writer', holder: 'away' }).create()
    await new Route({ unum: 'home', model: 'team', role: 'writer', holder: 'cloud' }).create()
    await new Scribe({ unum: 'home', model: 'copied', to: 'owner' }).create()
    await new Route({ unum: 'home', model: 'copied', role: 'owner', holder: 'away' }).create()
    await new Route({ unum: 'home', model: 'copied', role: 'reader', holder: 'home' }).create()
  })

  afterEach(() => {
    UnifistModel.unum = null
  })

  function down(from: MockSource, action: string): void {
    ;(from as any)[action] = async () => {
      throw new SourceError(`${from.name} is down`)
    }
  }

  it('test___init__', () => {
    // Where it is, and where it routes to, and nothing is being synced

    assert.equal(source.name, 'unum')
    assert.equal(source.unum, 'home')
    assert.equal(source.local, 'local')
    assert.deepEqual(source.members, { away: 'away', cloud: 'cloud' })
    assert.equal(source.chunk, null)
    assert.equal(source.KIND, 'unum')

    // With a chunk to read by, or with nothing but a name

    assert.equal(new UnumSource('paged', { chunk: 5 }).chunk, 5)
    assert.equal(new UnumSource('plain').chunk, null)
  })

  it('test_init', () => {
    // Every source it routes to has to know the model

    new Item()

    for (const each of [local, away, cloud]) {
      assert.equal(each.data.item.size, 0)
    }
  })

  it('test_create', async () => {
    // With nothing saying otherwise a record is written here

    const item: any = await new Item({ name: 'a' }).create()

    assert.equal(item.id, '1:item.unum:home')
    assert.deepEqual(keys(local.data.item), ['1:item.unum:home'])
    assert.deepEqual(keys(away.data.item), [])

    // To its owner, who's away

    const owned: any = await new Owned({ name: 'b' }).create()

    assert.equal(owned.id, '1:owned.unum:home')
    assert.deepEqual(keys(local.data.owned), [])
    assert.deepEqual(keys(away.data.owned), ['1:owned.unum:home'])

    // Or here, when the owner is this unum

    await new Mine({ name: 'c' }).create()

    assert.deepEqual(keys(local.data.mine), ['1:mine.unum:home'])

    // To the first of its writers

    await new Team({ name: 'd' }).create()

    assert.deepEqual(keys(away.data.team), ['1:team.unum:home'])
    assert.deepEqual(keys(cloud.data.team), [])

    // Or the next, if that one is down

    down(away, 'create')

    await new Team({ name: 'e' }).create()

    assert.deepEqual(keys(cloud.data.team), ['2:team.unum:home'])

    // Or nothing, if they all are

    down(cloud, 'create')

    await rejectsWith(() => new Team({ name: 'f' }).create(), 'SourceError', /cloud is down/)

    // Anything that isn't a source being down is not for it to try the next for

    away.create = async () => {
      throw new Error('whoops')
    }

    await rejectsWith(() => new Team({ name: 'g' }).create(), 'Error', /whoops/)
    assert.deepEqual(keys(cloud.data.team), ['2:team.unum:home'])
  })

  it('test_retrieve', async () => {
    // From here, when that's where it is

    const item: any = await new Item({ name: 'a' }).create()

    assert.equal(((await Item.one(item.id).retrieve()) as any).name, 'a')

    // From its owner, when that's where it is

    const owned: any = await new Owned({ name: 'b' }).create()

    assert.deepEqual(keys(local.data.owned), [])
    assert.equal(((await Owned.one(owned.id).retrieve()) as any).name, 'b')

    // From its writers, the first that has it

    const team: any = await new Team({ name: 'c' }).create()

    assert.equal(((await Team.one(team.id).retrieve()) as any).name, 'c')

    // From here first, when this unum holds a copy though it's not the owner

    const copied: any = await new Copied({ name: 'e' }).create()
    local.data.copied.set(copied.id, { id: copied.id, version: 1, name: 'copy' })

    assert.equal(away.data.copied.get(copied.id)!.name, 'e')
    assert.equal(((await Copied.one(copied.id).retrieve()) as any).name, 'copy')

    // Or the next, when the first doesn't have it, because it was down when it was written, or is down now

    down(away, 'create')

    const other: any = await new Team({ name: 'd' }).create()

    assert.deepEqual(keys(cloud.data.team), [other.id])
    assert.equal(((await Team.one(other.id).retrieve()) as any).name, 'd')

    down(away, 'retrieve')

    assert.equal(((await Team.one(other.id).retrieve()) as any).name, 'd')

    // A record with no id to go by is looked for here

    assert.deepEqual(((await Item.many({ name: 'a' }).retrieve()) as any).export(), [{ id: item.id, version: 1, name: 'a' }])
  })

  it('test_update', async () => {
    // Goes where the record is written to

    const owned: any = await new Owned({ name: 'a' }).create()

    owned.name = 'b'
    await owned.update()

    assert.equal(away.data.owned.get(owned.id)!.name, 'b')
    assert.deepEqual(keys(local.data.owned), [])

    const item: any = await new Item({ name: 'c' }).create()

    item.name = 'd'
    await item.update()

    assert.equal(local.data.item.get(item.id)!.name, 'd')

    // A record that clashed isn't to be used, until it's sorted out, or it's said to be used anyway

    await new Clash({ id: `2:${item.id}:away`, what: { error: 'version' } }).create()

    item.name = 'e'

    await rejectsWith(() => item.update(), 'ClashError', /item: clashed/)

    assert.equal(local.data.item.get(item.id)!.name, 'd')

    const again: any = await Item.one(item.id).retrieve()
    again.name = 'f'
    await again.update({ force: true })

    assert.equal(local.data.item.get(item.id)!.name, 'f')

    // What else is asked of the write goes on to the source, force being taken here

    const seen: any[][] = []
    const real = (local as any).update.bind(local)

    ;(local as any).update = async (model: any, ...args: any[]) => {
      seen.push(args)
      return real(model, ...args)
    }

    again.name = 'f2'
    await again.update({ force: true, note: 'x' })
    again.name = 'f'
    await again.update({ force: true })

    assert.deepEqual(seen, [[{ note: 'x' }], []])

    // By a query too, for the ones that clashed, and not for the others

    const other: any = await new Item({ name: 'g' }).create()

    assert.equal(await Item.many({ name__in: ['g', 'f'] }).set({ name: 'h' }).update({ force: true }), 2)

    await new Clash({ id: `2:${other.id}:away`, what: { error: 'version' } }).create()

    await rejectsWith(() => Item.many({ name: 'h' }).set({ name: 'i' }).update(), 'ClashError', /item: clashed/)

    // Not while syncing, where clashes are what's recorded

    await source.syncing(async () => {
      assert.equal(await Item.many({ name: 'h' }).set({ name: 'j' }).update(), 2)
    })
  })

  it('test_delete', async () => {
    // Goes where the record is written to

    const owned: any = await new Owned({ name: 'a' }).create()

    await owned.delete()

    assert.deepEqual(keys(away.data.owned), [])

    const item: any = await new Item({ name: 'b' }).create()

    await item.delete()

    assert.deepEqual(keys(local.data.item), [])

    // A record that clashed isn't to be used, until it's sorted out, or it's said to be used anyway

    const clash: any = await new Item({ name: 'c' }).create()
    await new Clash({ id: `2:${clash.id}:away`, what: { error: 'version' } }).create()

    await rejectsWith(() => Item.one(clash.id).delete(), 'ClashError', /item: clashed/)
    await rejectsWith(() => Item.many({ name: 'c' }).delete(), 'ClashError', /item: clashed/)

    assert.deepEqual(keys(local.data.item), [clash.id])

    assert.equal(await Item.one(clash.id).delete({ force: true }), 1)
    assert.deepEqual(keys(local.data.item), [])
  })

  it('test_syncing', async () => {
    // Writes and reads stay here while syncing, whatever the routes say, because what's synced is a copy

    await new Scribe({ unum: 'away', model: 'item', to: 'owner' }).create()
    await new Route({ unum: 'away', model: 'item', role: 'owner', holder: 'away' }).create()

    let item: any = null

    await source.syncing(async () => {
      item = await new Item({ id: '5:item.unum:away', name: 'a' }).create()
    })

    assert.deepEqual(keys(local.data.item), ['5:item.unum:away'])
    assert.deepEqual(keys(away.data.item), [])

    await source.syncing(async () => {
      assert.equal(((await Item.one(item.id).retrieve()) as any).name, 'a')
    })

    // And not after

    await new Item({ id: '6:item.unum:away', name: 'b' }).create()

    assert.deepEqual(keys(away.data.item), ['6:item.unum:away'])

    // Not even if what's done while it's open fails

    await assert.rejects(
      () =>
        source.syncing(async () => {
          throw new Error('whoops')
        }),
      /whoops/
    )

    await new Item({ id: '7:item.unum:away', name: 'c' }).create()

    assert.deepEqual(keys(away.data.item), ['6:item.unum:away', '7:item.unum:away'])
  })

  /** local has a, d, g, j, m and p, away b, e, h, k, n and q, cloud c, f, i, l, o and r, so sorted by name
   * they interleave, and away also has a copy of local's first */
  function fill(): Record<string, string> {
    new Item()

    const rows: Record<string, string> = {}

    ;[
      [local, 'home'],
      [away, 'away'],
      [cloud, 'cloud']
    ].forEach(([each, unum], number) => {
      for (let position = 0; position < 6; position++) {
        const id = `${position + 1}:item.unum:${unum}`
        const name = 'abcdefghijklmnopqr'[position * 3 + number]
        ;(each as MockSource).data.item.set(id, { id, version: 1, name })
        rows[name] = id
      }
    })

    away.data.item.set('1:item.unum:home', { id: '1:item.unum:home', version: 1, name: 'a' })

    return rows
  }

  function served(): number[] {
    const counts: number[] = []

    for (const each of [local, away, cloud]) {
      const retrieve = each.retrieve.bind(each)

      each.retrieve = async (model: any, ...args: any[]) => {
        const result = await retrieve(model, ...args)
        counts.push(model._models.length)
        return result
      }
    }

    return counts
  }

  it('test_stream', async () => {
    fill()
    source.chunk = 2

    // One member's rows in order, a page at a time and only as they're asked for

    const counts = served()
    const stream = source.stream('away', Item.many().sort('name'), ['+name'])
    const first: string[] = []

    for (let each = 0; each < 3; each++) {
      first.push(((await stream.next()).value as any).name)
    }

    assert.deepEqual(first, ['a', 'b', 'e'])
    assert.deepEqual(counts, [2, 2])

    // To the end, where a short page says it's over

    const rest: string[] = []

    for await (const row of stream) {
      rest.push((row as any).name)
    }

    assert.deepEqual(rest, ['h', 'k', 'n', 'q'])
    assert.deepEqual(counts, [2, 2, 2, 1])

    // With what the query filters by, and in the order it says

    const filtered: string[] = []

    for await (const row of source.stream('away', Item.many({ name__in: ['b', 'k', 'q'] }).sort('-name'), ['-name'])) {
      filtered.push((row as any).name)
    }

    assert.deepEqual(filtered, ['q', 'k', 'b'])

    // Anything but a source being down is raised

    away.retrieve = async () => {
      throw new Error('whoops')
    }

    await assert.rejects(async () => {
      for await (const row of source.stream('away', Item.many().sort('name'), ['+name'])) {
        assert.ok(row)
      }
    }, /whoops/)
  })

  it('test_select', async () => {
    const rows = fill()
    source.chunk = 2

    const names = async (query: any) => ((await query.retrieve()) as any).models.map((row: any) => row.name)

    // Every member's rows in the order of the query, as if it was one, a record that's in more than one only once

    assert.deepEqual(await names(Item.many().sort('name')), 'abcdefghijklmnopqr'.split(''))
    assert.deepEqual(await names(Item.many().sort('-name')), 'rqponmlkjihgfedcba'.split(''))
    assert.deepEqual(
      await names(Item.many()),
      Object.entries(rows)
        .map(([name, id]) => [id, name] as [string, string])
        .sort((first, second) => (first[0] < second[0] ? -1 : 1))
        .map(([, name]) => name)
    )

    // With filters and limits

    assert.deepEqual(await names(Item.many({ name__in: ['r', 'a', 'h', 'x'] }).sort('name')), ['a', 'h', 'r'])
    assert.deepEqual(await names(Item.many().sort('name').limit(3)), ['a', 'b', 'c'])
    assert.deepEqual(await names(Item.many().sort('name').limit({ limit: 4, start: 5 })), ['f', 'g', 'h', 'i'])
    assert.deepEqual(await names(Item.many().sort('name').limit({ page: 2, perPage: 5 })), ['f', 'g', 'h', 'i', 'j'])

    // Reading only what's needed, not everything to sort it

    const counts = served()

    assert.deepEqual(await names(Item.many().sort('name').limit(3)), ['a', 'b', 'c'])

    const total = counts.reduce((sum, count) => sum + count, 0)

    assert.ok(6 <= total && total <= 10, `read ${total} rows`)

    // A source that can't be reached just has no rows

    down(cloud, 'retrieve')

    assert.deepEqual(await names(Item.many().sort('name')), 'abdeghjkmnpq'.split(''))

    // Whatever's picked from is still a model of those records

    const found: any = await Item.many().sort('name').limit(2).retrieve()

    assert.deepEqual(found.export(), [
      { id: rows.a, version: 1, name: 'a' },
      { id: rows.b, version: 1, name: 'b' }
    ])

    found[0].name = 'z'
    await found[0].update()

    assert.equal(local.data.item.get(rows.a)!.name, 'z')

    // It says when a limit was reached, so there may be more

    assert.equal(found.overflow, true)
    assert.equal(((await Item.many().sort('name').limit(100).retrieve()) as any).overflow, false)
  })

  it('test_count', async () => {
    // Everything else is still here for now

    await new Item({ name: 'a' }).create()
    await new Item({ name: 'b' }).create()

    assert.equal(await Item.many().count(), 2)
  })
})

// --------------------------------------------------------------------------- apply and sync

describe('apply', () => {
  let unifist: MockSource
  let local: MockSource
  let away: MockSource
  let source: UnumSource
  let known: Record<string, any>

  beforeEach(async () => {
    clear()

    unifist = new MockSource('unifist')
    local = new MockSource('local')
    away = new MockSource('away')

    source = new UnumSource('unum', { unum: 'home', local: 'local', members: { away: 'away' } })
    known = models(Item)

    UnifistModel.unum = 'home'

    // The records away owns are written to away, but sync writes the copies here

    await new Scribe({ unum: 'away', model: 'item', to: 'owner' }).create()
    await new Route({ unum: 'away', model: 'item', role: 'owner', holder: 'away' }).create()
  })

  afterEach(() => {
    UnifistModel.unum = null
  })

  function row(id: string, action: string, what: Record<string, any>): any {
    return {
      id,
      resource_id: '5:item.unum:away',
      what: { action, app: 'unum', block: 'item', id: '5:item.unum:away', ...what }
    }
  }

  function journaled(): string[] {
    return [...unifist.data.journal.keys()].map(String)
  }

  function clashes(): Record<string, any> {
    return Object.fromEntries([...unifist.data.clash.entries()].map(([id, record]) => [id, record.what]))
  }

  it('test_apply', async () => {
    const created = row('1:5:item.unum:away:away', 'create', { after: { id: '5:item.unum:away', version: 1, name: 'a' } })
    const updated = row('2:5:item.unum:away:away', 'update', {
      before: { id: '5:item.unum:away', version: 1, name: 'a' },
      after: { id: '5:item.unum:away', version: 2, name: 'b' }
    })
    const deleted = row('3:5:item.unum:away:away', 'delete', { before: { id: '5:item.unum:away', version: 2, name: 'b' } })

    // A create is made here, not to the owner, and its journal row is the one it came with, so the transaction is the same

    assert.equal(await apply(source, created, known), 'applied')
    assert.equal(local.data.item.get('5:item.unum:away')!.name, 'a')
    assert.equal(away.data.item.size, 0)
    assert.deepEqual(journaled(), ['1:5:item.unum:away:away'])

    // An update too, from the version it was

    assert.equal(await apply(source, updated, known), 'applied')
    assert.equal(local.data.item.get('5:item.unum:away')!.name, 'b')
    assert.equal(local.data.item.get('5:item.unum:away')!.version, 2)
    assert.deepEqual(journaled(), ['1:5:item.unum:away:away', '2:5:item.unum:away:away'])

    // One that's already here is skipped, whatever it was, so syncing twice does nothing

    assert.equal(await apply(source, created, known), 'skipped')
    assert.equal(await apply(source, updated, known), 'skipped')
    assert.equal(local.data.item.get('5:item.unum:away')!.version, 2)

    // As is a delete

    assert.equal(await apply(source, deleted, known), 'applied')
    assert.equal(local.data.item.size, 0)
    assert.equal(journaled()[2], '3:5:item.unum:away:away')

    // Nothing broke

    assert.deepEqual(clashes(), {})

    // An update from a version it isn't at is a clash, and the record is left as it is. So is a delete

    await source.syncing(async () => {
      await new Item({ id: '6:item.unum:away', name: 'c' }).create()
      await Item.many({ id: '6:item.unum:away' }).set({ name: 'd' }).update()
    })

    const stale = row('2:6:item.unum:away:cloud', 'update', {
      id: '6:item.unum:away',
      before: { id: '6:item.unum:away', version: 1, name: 'c' },
      after: { id: '6:item.unum:away', version: 2, name: 'e' }
    })
    const late = row('2:6:item.unum:away:cloud', 'delete', {
      id: '6:item.unum:away',
      before: { id: '6:item.unum:away', version: 1, name: 'c' }
    })

    assert.equal(await apply(source, stale, known), 'clash')
    assert.equal(local.data.item.get('6:item.unum:away')!.name, 'd')
    assert.deepEqual(clashes(), { '2:6:item.unum:away:cloud': { error: 'version' } })

    // Once it's a clash it's left alone, until someone sorts it out

    assert.equal(await apply(source, late, known), 'clash')
    assert.equal(Object.keys(clashes()).length, 1)

    // Changing a record that isn't here is one too

    const gone = row('2:7:item.unum:away:away', 'update', {
      id: '7:item.unum:away',
      before: { id: '7:item.unum:away', version: 1, name: 'f' },
      after: { id: '7:item.unum:away', version: 2, name: 'g' }
    })

    assert.equal(await apply(source, gone, known), 'clash')
    assert.deepEqual(clashes()['2:7:item.unum:away:away'], { error: 'missing' })

    // And so is making one that is

    await source.syncing(async () => {
      await new Item({ id: '8:item.unum:away', name: 'h' }).create()
    })

    const twice = row('1:8:item.unum:away:cloud', 'create', {
      id: '8:item.unum:away',
      after: { id: '8:item.unum:away', version: 1, name: 'i' }
    })

    assert.equal(await apply(source, twice, known), 'clash')
    assert.deepEqual(clashes()['1:8:item.unum:away:cloud'], { error: 'exists' })
    assert.equal(local.data.item.get('8:item.unum:away')!.name, 'h')

    // Or a model that isn't known

    const unknown = row('1:9:nope.unum:away:away', 'create', { after: { id: '9:nope.unum:away', version: 1 } })
    unknown.what.block = 'nope'

    assert.equal(await apply(source, unknown, known), 'clash')
    assert.deepEqual(clashes()['1:9:nope.unum:away:away'], { error: 'model' })

    // Something else going wrong is not for apply to hide

    const broken = row('1:10:item.unum:away:away', 'create', {
      id: '10:item.unum:away',
      after: { id: '10:item.unum:away', version: 1, name: 'j' }
    })

    local.create = async () => {
      throw new SourceError('local is down')
    }

    await rejectsWith(() => apply(source, broken, known), 'SourceError', /local is down/)
    assert.equal(clashes()['1:10:item.unum:away:away'], undefined)

    // And it's not syncing after

    assert.equal((source as any)._syncing, false)
  })
})

describe('sync', () => {
  let unifist: MockSource
  let local: MockSource
  let away: MockSource
  let source: UnumSource
  let known: Record<string, any>
  let member: any

  beforeEach(() => {
    clear()

    unifist = new MockSource('unifist')
    local = new MockSource('local')
    away = new MockSource('away')

    source = new UnumSource('unum', { unum: 'home', local: 'local', members: { away: 'away' } })
    known = models(Item)
    member = journal(source, 'away')

    UnifistModel.unum = 'home'
  })

  afterEach(() => {
    UnifistModel.unum = null
  })

  async function write(transaction: string, when: number, action: string, what: Record<string, any>): Promise<void> {
    await new member({
      id: transaction,
      resource_id: what.id,
      when,
      what: { action, app: 'unum', block: 'item', ...what }
    }).create()
  }

  it('test_sync', async () => {
    const five = '5:item.unum:away'
    const six = '6:item.unum:away'

    // What away has written, put in out of order, to be applied by when. Record 5 is made, changed and deleted, record 6
    // is made, and then changed by someone else from a version it isn't at

    await write('3:5:item.unum:away:away', 30, 'delete', { id: five, before: { id: five, version: 2, name: 'b' } })
    await write('2:6:item.unum:away:cloud', 25, 'update', {
      id: six,
      before: { id: six, version: 5, name: 'c' },
      after: { id: six, version: 6, name: 'd' }
    })
    await write('2:5:item.unum:away:away', 20, 'update', {
      id: five,
      before: { id: five, version: 1, name: 'a' },
      after: { id: five, version: 2, name: 'b' }
    })
    await write('1:6:item.unum:away:away', 15, 'create', { id: six, after: { id: six, version: 1, name: 'c' } })
    await write('1:5:item.unum:away:away', 10, 'create', { id: five, after: { id: five, version: 1, name: 'a' } })

    // They're applied in order, to the copies here, and the journal here has the same rows

    assert.deepEqual(await sync(source, 'away', known), { applied: 4, skipped: 0, clash: 1 })

    assert.deepEqual([...local.data.item.keys()], [six])
    assert.equal(local.data.item.get(six)!.name, 'c')
    assert.equal(away.data.item.size, 0)
    assert.deepEqual([...unifist.data.journal.keys()], [
      '1:5:item.unum:away:away',
      '1:6:item.unum:away:away',
      '2:5:item.unum:away:away',
      '3:5:item.unum:away:away'
    ])
    assert.deepEqual(
      Object.fromEntries([...unifist.data.clash.entries()].map(([id, record]) => [id, record.what])),
      { '2:6:item.unum:away:cloud': { error: 'version' } }
    )

    // Again, it's all done already

    assert.deepEqual(await sync(source, 'away', known), { applied: 0, skipped: 4, clash: 1 })
    assert.equal(unifist.data.journal.size, 4)
    assert.equal(unifist.data.clash.size, 1)

    // New rows since are applied, and the rest aren't

    await write('2:6:item.unum:away:away', 40, 'update', {
      id: six,
      before: { id: six, version: 1, name: 'c' },
      after: { id: six, version: 2, name: 'e' }
    })

    assert.deepEqual(await sync(source, 'away', known), { applied: 1, skipped: 4, clash: 1 })
    assert.equal(local.data.item.get(six)!.name, 'e')

    // If away can't be reached it's raised, for the next time, and nothing is done

    away.retrieve = async () => {
      throw new SourceError('away is down')
    }

    await rejectsWith(() => sync(source, 'away', known), 'SourceError', /away is down/)

    assert.equal(local.data.item.get(six)!.name, 'e')
  })
})
