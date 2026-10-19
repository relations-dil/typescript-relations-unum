/**
 * Relations Unum - routing, syncing and clashes across unums.
 *
 * A source that routes each operation on a record to the source that has it, here or in another unum, and
 * the tables and functions that say where that is and keep the copies in step. It builds on the core library's
 * `Source` and the Unifist source's ids and journal, so it works over any relations source.
 *
 * ```ts
 * import { UnumSource } from '@relations-dil/unum'
 *
 * new UnumSource('unum', { unum: 'home', local: 'local', members: { away: 'away' } })
 * ```
 */

import {
  ModelError,
  NotFoundError,
  Source,
  SourceError,
  UniqueError,
  dict,
  fields,
  int,
  source as lookup,
  str
} from '@relations-dil/relations'
import type { ModelIdentity } from '@relations-dil/relations'
import { Journal, UnifistBase } from '@relations-dil/unifist'

/** A record that clashed isn't to be used until it's sorted out */
export class ClashError extends ModelError {
  constructor(model: any, message: string) {
    super(model, message)
    this.name = 'ClashError'
  }
}

/** What broke, with the same id as the journal row it's about, version:identifier:resource:owner:writer */
export class Clash extends fields({ id: str, what: { kind: dict, none: false } }, UnifistBase) {
  static unique = {}
}

/** A string column that is never null, blank meaning any when it's matched */
function blank(): any {
  return { kind: str, default: '', none: false }
}

/**
 * What Route and Scribe share, matching a record's id on its parts (identifier, model, source and unum), blank
 * meaning any
 */
export class Matching extends UnifistBase {
  /** How many of the parts are set, the more the more it matches */
  specificity(): number {
    const row = this as any

    return [row.identifier, row.model, row.source, row.unum].filter((part) => part).length
  }

  /** Shown like a record's id, with a * for any, though a blank is what's kept */
  pattern(): string {
    const row = this as any

    return `${row.identifier || '*'}:${row.model || '*'}.${row.source || '*'}:${row.unum || '*'}`
  }
}

/** Who has the data that matches, in what role, and where to reach them (a url, blank for here) */
export class Route extends fields(
  {
    id: int,
    identifier: blank(),
    model: blank(),
    source: blank(),
    unum: blank(),
    role: ['owner', 'writer', 'reader'],
    holder: { kind: str, none: false },
    url: blank()
  },
  Matching
) {
  static unique = ['identifier', 'model', 'source', 'unum', 'role', 'holder']
}

/** Where a write goes for the data that matches, one row for each match */
export class Scribe extends fields(
  {
    id: int,
    identifier: blank(),
    model: blank(),
    source: blank(),
    unum: blank(),
    to: ['owner', 'writer', 'local']
  },
  Matching
) {
  static unique = ['identifier', 'model', 'source', 'unum']
}

/**
 * The clashes a record has, whoever wrote and whatever version, which are in the clash's id,
 * version:identifier:resource:owner:writer, between the version and the writer
 */
export async function clashed(recordId: string): Promise<any[]> {
  return [...((await (Clash as any).many({ id__like: `:${recordId}:` }).retrieve()) as any).models]
}

/** The rows of a kind (Route or Scribe) that match a record's id, which is identifier:model.source:unum */
async function matching(kind: any, recordId: string): Promise<any[]> {
  const first = recordId.indexOf(':')
  const second = recordId.indexOf(':', first + 1)
  const identifier = recordId.slice(0, first)
  const resource = recordId.slice(first + 1, second)
  const unum = recordId.slice(second + 1)
  const dot = resource.indexOf('.')
  const model = resource.slice(0, dot)
  const source = resource.slice(dot + 1)

  const found = await kind
    .many({ identifier__in: ['', identifier], model__in: ['', model], source__in: ['', source], unum__in: ['', unum] })
    .retrieve()

  return [...found.models]
}

/**
 * Who has a record's data, in whatever role. For each role the rows that match the most win, so what a model or a
 * record says beats what its unum says. Owners, then writers, then readers, each in the order made
 */
export async function route(recordId: string): Promise<any[]> {
  const roles = ['owner', 'writer', 'reader']
  const rows = await matching(Route, recordId)
  const best: Record<string, number> = {}

  for (const row of rows) {
    best[row.role] = Math.max(best[row.role] ?? 0, row.specificity())
  }

  return rows
    .filter((row) => row.specificity() === best[row.role])
    .sort((first, second) => roles.indexOf(first.role) - roles.indexOf(second.role) || first.id - second.id)
}

/**
 * Where a write to a record goes, from the one row that matches the most, the first made if some match as much, or
 * null if none match
 */
export async function scribe(recordId: string): Promise<any | null> {
  const rows = await matching(Scribe, recordId)

  if (!rows.length) {
    return null
  }

  return rows.sort((first, second) => second.specificity() - first.specificity() || first.id - second.id)[0]
}

/** Whether a row comes before another by the sorting of a query, each field having a + or a - in front of it */
function before(first: any, second: any, sorting: string[]): boolean {
  for (const sort of sorting) {
    const mine = first[sort.slice(1)]
    const theirs = second[sort.slice(1)]

    if (mine !== theirs) {
      return sort[0] === '+' ? mine < theirs : mine > theirs
    }
  }

  return false
}

/** Streams in the order the sorting says as if they were one, reading each only as far as is needed, the first of equals first */
async function* merge(streams: AsyncGenerator<any>[], sorting: string[]): AsyncGenerator<any> {
  const heads = await Promise.all(streams.map((stream) => stream.next()))

  try {
    for (;;) {
      let best = -1

      heads.forEach((head, index) => {
        if (!head.done && (best === -1 || before(head.value, heads[best].value, sorting))) {
          best = index
        }
      })

      if (best === -1) {
        return
      }

      yield heads[best].value

      heads[best] = await streams[best].next()
    }
  } finally {
    await Promise.all(streams.map((stream) => stream.return(undefined)))
  }
}

/** Whether two values from a journal are the same, by what they say */
function same(first: any, second: any): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

/** What else was asked of a write, as the extra argument the source gets, or nothing if there isn't any */
function forward(rest: Record<string, any>): any[] {
  return Object.keys(rest).length ? [rest] : []
}

/**
 * Routes each operation on a record to the source that has it. It stores nothing: it passes the call to the source
 * of the unum the record's routes and scribe say, here (`local`) or another unum's (`members`). The rest is still
 * here for now
 */
export class UnumSource extends Source {
  static KIND: string | null = 'unum'

  /** Name of this unum */
  declare unum: string
  /** Name of the source this unum's own data is in */
  declare local: string
  /** Name of the source of each other unum, by the unum's name */
  declare members: Record<string, string>
  /** How many rows to read from a unum at a time, the model's if not set */
  declare chunk: number | null
  /** Whether what's written and read is the copy here, for sync */
  declare _syncing: boolean

  constructor(name: string, options: Record<string, any> = {}) {
    super(name, options)

    this.chunk = this.chunk ?? null
    this._syncing = false
  }

  /** Keeps writes and reads here while the work is done, because what sync applies is a copy of what's elsewhere */
  async syncing<T>(work: () => Promise<T>): Promise<T> {
    this._syncing = true

    try {
      return await work()
    } finally {
      this._syncing = false
    }
  }

  /** The names of the sources of those who hold a record in the roles, in order, local being this unum's own */
  async sources(recordId: string, roles: string[]): Promise<string[]> {
    return (await route(recordId))
      .filter((row) => roles.includes(row.role))
      .map((row) => (row.holder === this.unum ? this.local : this.members[row.holder]))
  }

  /** Does the action on the first of the sources that can, the last one's error being the one thrown */
  async attempt(names: string[], action: string, model: any, ...args: any[]): Promise<any> {
    for (const name of names.slice(0, -1)) {
      try {
        return await (lookup(name) as any)[action](model, ...args)
      } catch (error) {
        if (error instanceof SourceError || error instanceof NotFoundError) {
          continue
        }

        throw error
      }
    }

    return (lookup(names[names.length - 1]) as any)[action](model, ...args)
  }

  /** Every source it routes to has to know the model */
  init(model: ModelIdentity): void {
    for (const name of new Set([this.local, ...Object.values(this.members)])) {
      ;(lookup(name) as any).init(model)
    }
  }

  /** Writes to where the scribe says, the owner, the writers or here, or here if there's no one to say */
  async write(action: string, model: any, ...args: any[]): Promise<any> {
    const rule = this._syncing ? null : await scribe(model.id)
    const names = rule && rule.to !== 'local' ? await this.sources(model.id, [rule.to]) : []

    return this.attempt(names.length ? names : [this.local], action, model, ...args)
  }

  /** Creates where it's written to */
  async create(model: any, ...args: any[]): Promise<any> {
    return this.write('create', model, ...args)
  }

  /**
   * Reads the rows of a query from one source in order, a page at a time and only as they're asked for. A source
   * that can't be reached has no rows, so the others are read without it
   */
  async *stream(name: string, model: any, sorting: string[]): AsyncGenerator<any> {
    const chunk = this.chunk || model._chunk

    let start = 0

    for (;;) {
      const page = (model.constructor as any).many()

      page._record = model._record.copy()
      page._like = model._like
      page._sort = [...sorting]
      page.limit({ limit: chunk, start })

      let rows: any[]

      try {
        rows = (await (lookup(name) as any).retrieve(page))._models
      } catch (error) {
        if (error instanceof SourceError) {
          return
        }

        throw error
      }

      yield* rows

      if (rows.length < chunk) {
        return
      }

      start += chunk
    }
  }

  /**
   * Every source's rows of a query in the order it says, as if it was one, with a record that's in more than one only
   * once, the first of them, from here before others. Nothing is read until it's needed
   */
  async *select(model: any): AsyncGenerator<any> {
    const sorting = model._ordering(model._sort?.length ? model._sort : model._order)
    const names = [...new Set([this.local, ...Object.values(this.members)])]
    const seen = new Set<string>()

    for await (const row of merge(
      names.map((name) => this.stream(name, model, sorting)),
      sorting
    )) {
      if (!seen.has(row.id)) {
        seen.add(row.id)
        yield row
      }
    }
  }

  /**
   * Retrieves a record by its id from here if this unum holds it, or else its owner, writers and readers in turn.
   * A query for many is every source's rows merged in order, and one without an id is from here
   */
  async retrieve(model: any, verify = true, ...args: any[]): Promise<any> {
    if (model._mode === 'many' && !this._syncing) {
      const start = model._offset || 0
      const stop = model._limit === null ? null : start + model._limit
      const picked: any[] = []

      let index = 0

      for await (const row of this.select(model)) {
        if (index >= start) {
          picked.push(row)
        }

        index += 1

        if (stop !== null && index >= stop) {
          break
        }
      }

      model._models = picked
      model._record = null
      model._action = 'update'
      model.overflow = model.overflow || (model._limit !== null && picked.length >= model._limit)

      return model
    }

    const criteria = model._record.field(model._id).criteria
    const names = criteria?.eq && !this._syncing ? await this.sources(criteria.eq, ['owner', 'writer', 'reader']) : []

    if (names.includes(this.local)) {
      names.splice(names.indexOf(this.local), 1)
      names.unshift(this.local)
    }

    return this.attempt(names.length ? names : [this.local], 'retrieve', model, verify, ...args)
  }

  /** Refuses a record that clashed, unless it's said to use it anyway, or it's sync that's writing */
  async refuse(model: any, force: boolean): Promise<void> {
    if (!force && !this._syncing && (await clashed(model.id)).length) {
      throw new ClashError(model, 'clashed, use { force: true } to use it anyway')
    }
  }

  /** Updates where it's written to, unless it clashed and force isn't set, which is taken here, not sent on */
  async update(model: any, options: Record<string, any> = {}, ...args: any[]): Promise<number> {
    const { force = false, ...rest } = options

    await this.refuse(model, force)

    return this.write('update', model, ...forward(rest), ...args)
  }

  /** Deletes where it's written to, unless it clashed and force isn't set, which is taken here, not sent on */
  async delete(model: any, options: Record<string, any> = {}, ...args: any[]): Promise<number> {
    const { force = false, ...rest } = options

    await this.refuse(model, force)

    return this.write('delete', model, ...forward(rest), ...args)
  }

  /** Counts here for now */
  async count(model: any, ...args: any[]): Promise<any> {
    return (lookup(this.local) as any).count(model, ...args)
  }
}

/** The models sync can apply, by the app (source) and block (model) a journal row has, as `source.name` */
export function models(...classes: any[]): Record<string, any> {
  return Object.fromEntries(
    classes.map((model) => {
      const identity = model.thy()

      return [`${identity.SOURCE}.${identity.NAME}`, model]
    })
  )
}

/** Records a journal row that can't be applied, with the same id, and returns that it clashed */
async function clash(row: any, error: string): Promise<'clash'> {
  await new (Clash as any)({ id: row.id, what: { error } }).create()

  return 'clash'
}

/**
 * Applies a journal row from another unum here, by making the same write with the writer the row says, so the
 * journal row that's written has the same id and the transaction is the same everywhere. A row that's here is
 * skipped, and one that clashed is left alone. One that can't be applied, because the record isn't at the version
 * it was from, or isn't there, or already is, or its model isn't known, is a clash. Resolves to what it did
 */
export async function apply(source: UnumSource, row: any, known: Record<string, any>): Promise<'applied' | 'skipped' | 'clash'> {
  if (await (Journal as any).one(row.id).retrieve(false)) {
    return 'skipped'
  }

  if (await (Clash as any).one(row.id).retrieve(false)) {
    return 'clash'
  }

  const what = row.what
  const model = known[`${what.app}.${what.block}`]

  if (!model) {
    return clash(row, 'model')
  }

  const writer = row.id.slice(row.id.lastIndexOf(':') + 1)

  return source.syncing(async () => {
    try {
      if (what.action === 'create') {
        await new model(what.after).create({ writer })
      } else {
        const before = what.before
        const query = model.many({ id: what.id, version: before.version })

        let done: number

        if (what.action === 'update') {
          const changes = Object.fromEntries(
            Object.entries(what.after).filter(([name, value]) => !['id', 'version'].includes(name) && !same(value, before[name]))
          )

          done = await query.set(changes).update({ writer })
        } else {
          done = await query.delete({ writer })
        }

        if (!done) {
          return clash(row, (await model.many({ id: what.id }).count()) ? 'version' : 'missing')
        }
      }
    } catch (error) {
      if (error instanceof UniqueError) {
        return clash(row, 'exists')
      }

      throw error
    }

    return 'applied'
  })
}

/**
 * Another unum's journal, the same as the one here but in the source that unum's records are in. It's the
 * journal here with the source changed
 */
export function journal(source: UnumSource, member: string): any {
  return class extends Journal {
    static title = 'Journal'
    static store = 'journal'
    static source = source.members[member]
  }
}

/**
 * Applies what another unum's journal has that this one doesn't, oldest first, one row at a time, and resolves to
 * how many were applied, skipped because they were here already, and clashed. If the other unum can't be reached
 * the error is thrown, to be tried again
 */
export async function sync(source: UnumSource, member: string, known: Record<string, any>): Promise<Record<string, number>> {
  const counts: Record<string, number> = { applied: 0, skipped: 0, clash: 0 }
  const rows = await journal(source, member).many().sort('when', 'id').retrieve()

  for (const row of rows.models) {
    counts[await apply(source, row, known)] += 1
  }

  return counts
}
