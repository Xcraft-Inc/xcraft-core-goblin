// @ts-check
'use strict';

const {SQLite} = require('xcraft-core-book');
const xLog = require('xcraft-core-log')('cryo');
const {LastPersistedActionShape, EmbeddingsShape} = require('./shapes.js');
const {
  QueryBuilder,
  FromQuery,
} = require('xcraft-core-pickaxe/lib/query-builder.js');
const {getActorRipleyDB} = require('../index.js');

function escape(value) {
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

function sqlPath(path) {
  return `json_extract(action, '$.payload.state.' || ${escape(path)})`;
}

class CryoReader extends SQLite {
  #quest;

  constructor(location, db, getHandle, quest) {
    super(location);

    this.#quest = quest;
    this._queries = {};
    this._attached = {};
    this._dbName = db;
    this._getHandle = getHandle;

    this._queries.getGoblinState = `
      SELECT json_extract(action, '$.payload.state') as action
      FROM actions
      WHERE goblin = $goblin
        AND type = $type
      ORDER BY rowid DESC
      LIMIT 1;
    `;

    this._queries.getGoblinIds = `
      SELECT distinct(substr(goblin, instr(goblin,'-') + 1)) AS goblinId
      FROM actions
      WHERE goblin GLOB $goblin
        AND type = $type
      ORDER BY rowid DESC
    `;

    this._queries.getLastGoblinIds = `
      SELECT substr(goblin, instr(goblin,'-') + 1) AS goblinId
      FROM lastPersistedActions
      WHERE goblin GLOB $goblin
      ORDER BY rowid DESC
    `;

    this._queries.hasPersistedGoblin = `
      SELECT 'true' as exist
      FROM actions
      WHERE goblin = $goblin
        AND type = 'persist'
      LIMIT 1
    `;

    this._queries.isPublished = `
      SELECT 'true' as exist
      FROM lastPersistedActions
      WHERE goblin = $goblin
      LIMIT 1
    `;

    this._queries.unstagedActions = `
      SELECT count(*) AS count
      FROM actions
      WHERE goblin = $goblin
        AND type != 'persist'
	      AND commitId IS NULL
      ORDER BY rowid DESC
    `;

    this._queries.attach = `ATTACH $attachPath as $name;`;
    this._queries.detach = `DETACH $name;`;
  }

  set quest(quest) {
    this.#quest = quest;
  }

  get quest() {
    return this.#quest;
  }

  _open(dbName) {
    const res = super.open(dbName, '', this._queries);
    if (!res) {
      xLog.warn('something wrong happens with SQLite');
    }
    return res;
  }

  getAttachPath() {
    return this._path(this._dbName);
  }

  attachReader(reader) {
    if (!this.tryToUse()) {
      return () => null;
    }
    if (!this._open(this._dbName)) {
      return () => null;
    }
    if (!reader.tryToUse()) {
      return () => null;
    }
    return this._attachDB(reader._dbName, reader.getAttachPath());
  }

  attachDB(name) {
    if (!this.tryToUse()) {
      return () => null;
    }
    if (!this._open(this._dbName)) {
      return () => null;
    }
    return this._attachDB(name, this._path(name));
  }

  _attachDB(name, attachPath) {
    if (this._attached[name]) {
      this._attached[name]++;
      return () => this._detachDB(name);
    }
    try {
      this.stmts(this._dbName).attach.run({attachPath, name});
      xLog.dbg(`database '${name}' attached to '${this._dbName}'`);
      this._attached[name] = 1;
      return () => this._detachDB(name);
    } catch (err) {
      xLog.err(err);
      return () => null;
    }
  }

  _detachDB(name) {
    if (this._attached[name]) {
      this._attached[name]--;
      if (this._attached[name] === 0) {
        this.stmts(this._dbName).detach.run({name});
        xLog.dbg(`db '${name}' detached from '${this._dbName}'`);
        delete this._attached[name];
      }
    }
  }

  *iterateQuery(sql) {
    if (!this.tryToUse()) {
      return null;
    }

    if (!this._open(this._dbName)) {
      return;
    }
    const statement = this.prepare(this._dbName, sql);
    for (const res of statement.iterate()) {
      yield res;
    }
  }

  getGoblinState(goblinId, type = 'persist') {
    if (!this.tryToUse()) {
      return null;
    }

    if (!this._open(this._dbName)) {
      return;
    }
    let goblin;
    if (goblinId.indexOf('@') === -1) {
      goblin = goblinId;
    } else {
      goblin = `${goblinId.split('@', 1)[0]}-${goblinId}`;
    }
    const result = this.stmts(this._dbName).getGoblinState.get({
      goblin,
      type,
    });
    if (!result) {
      return null;
    }
    if (!result.action) {
      return null;
    }
    return JSON.parse(result.action);
  }

  *getGoblinIds(goblinType, options) {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    let stmt;
    const bind = {goblin: `${goblinType}-*`};
    const last = options?.last || false;

    if (last) {
      stmt = this.stmts(this._dbName).getLastGoblinIds;
    } else {
      stmt = this.stmts(this._dbName).getGoblinIds;
      bind.type = options?.type || 'persist';
    }

    for (const {goblinId} of stmt.iterate(bind)) {
      yield goblinId;
    }
  }

  /**
   * @template {AnyObjectShape} T
   * @param {string} goblinType
   * @param {T} shape
   * @returns {FromQuery<[GetShape<T>]>}
   */
  queryArchetype(goblinType, shape) {
    if (!this.tryToUse()) {
      throw new Error('SQLite not usable');
    }

    if (!this._open(this._dbName)) {
      throw new Error('SQLite not opened');
    }

    const builder = new QueryBuilder({
      database: this._db[this._dbName],
      getTableSchema: (name, shape) => {
        const db = getActorRipleyDB(name);
        const isJoinedDb = db !== this._dbName;
        if (isJoinedDb) {
          this.#quest.defer(this.attachDB(db));
        }
        return QueryBuilder.TableSchema({
          db: isJoinedDb ? db : undefined,
          table: 'lastPersistedActions',
          alias: isJoinedDb ? `_${name}` : undefined,
          shape: shape,
          baseShape: LastPersistedActionShape(shape),
          scope: (row) => row.field('action').get('payload').get('state'),
          scopeCondition: (row, $) =>
            row.field('goblin').glob($.unsafeSql(`'${name}-*'`)),
        });
      },
    });
    return builder.from(goblinType, shape);
  }

  queryEmbeddings(vectors) {
    if (!this.tryToUse()) {
      throw new Error('SQLite not usable');
    }

    if (!this._open(this._dbName)) {
      throw new Error('SQLite not opened');
    }

    const queryBuilder = new QueryBuilder(this._db[this._dbName])
      .from('embeddings', EmbeddingsShape)
      .fields(['scope', 'locale', 'documentId', 'chunkId', 'chunk', 'distance'])
      .where((row) => row.field('embedding').match(new Float32Array(vectors)));
    return queryBuilder;
  }

  pickAction(id, properties) {
    if (!this.tryToUse()) {
      return null;
    }

    if (!this._open(this._dbName)) {
      return null;
    }

    const goblin = `${id.split('@', 1)[0]}-${id}`;

    const select = properties
      .map((path) => `${sqlPath(path)} as ${escape(path)}`)
      .join(',');

    const values = [goblin];
    const query = `
      SELECT ${select}
      FROM actions
      WHERE goblin = ?
      ORDER BY rowid DESC
      LIMIT 1
    `;

    const stmt = this.prepare(this._dbName, query);
    const result = stmt.get(values);
    if (!result) {
      return null;
    }

    for (const col of Object.keys(result)) {
      if (typeof result[col] !== 'string') {
        continue;
      }
      try {
        result[col] = JSON.parse(result[col]);
      } catch {
        /* ... */
      }
    }
    return result;
  }

  isPersisted(goblinId) {
    if (!this.tryToUse()) {
      return false;
    }

    if (!this._open(this._dbName)) {
      return false;
    }

    let goblin;
    if (goblinId.indexOf('@') === -1) {
      goblin = goblinId;
    } else {
      goblin = `${goblinId.split('@', 1)[0]}-${goblinId}`;
    }

    const result = this.stmts(this._dbName).hasPersistedGoblin.get({
      goblin,
    });
    return result?.exist ? true : false;
  }

  isPublished(goblinId) {
    if (!this.tryToUse()) {
      return false;
    }

    if (!this._open(this._dbName)) {
      return false;
    }

    let goblin;
    if (goblinId.indexOf('@') === -1) {
      goblin = goblinId;
    } else {
      goblin = `${goblinId.split('@', 1)[0]}-${goblinId}`;
    }

    const result = this.stmts(this._dbName).isPublished.get({
      goblin,
    });
    return result?.exist ? true : false;
  }

  commitStatus(goblinId) {
    if (!this.tryToUse()) {
      return false;
    }

    if (!this._open(this._dbName)) {
      return false;
    }

    let goblin;
    if (goblinId.indexOf('@') === -1) {
      goblin = goblinId;
    } else {
      goblin = `${goblinId.split('@', 1)[0]}-${goblinId}`;
    }

    const result = this.stmts(this._dbName).hasPersistedGoblin.get({
      goblin,
    });
    if (!result?.exist) {
      return 'none';
    }

    const {count} = this.stmts(this._dbName).unstagedActions.get({goblin});
    return count > 0 ? 'staged' : 'commited';
  }

  normalizeFileName(fileName) {
    const forbiddenChars = /[<>:"/\\|?*]/g;
    const reservedNames = /^(con|aux|prn|nul|com[1-9]|lpt[1-9])$/i;

    const normalizedFileName = fileName.replace(forbiddenChars, '_');

    if (normalizedFileName.match(reservedNames)) {
      return '_' + normalizedFileName;
    }

    return normalizedFileName;
  }
}

module.exports = CryoReader;
