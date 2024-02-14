'use strict';

const {SQLite} = require('xcraft-core-book');

function bind(value, valuesRef) {
  valuesRef.push(value);
  return '?';
}

function escape(value) {
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

function sqlPath(path) {
  return `json_extract(action, '$.payload.state.' || ${escape(path)})`;
}

function sqlCondition(condition, values) {
  if (condition.operator === 'includes') {
    return `EXISTS (
        SELECT *
        FROM json_each(${sqlPath(condition.path)})
        WHERE json_each.value IN (${condition.value
          .map((v) => bind(v, values))
          .join(',')}))`;
  }
  if (condition.operator === 'hasKey') {
    return `EXISTS (
        SELECT *
        FROM json_each(${sqlPath(condition.path)})
        WHERE json_each.key IN (${condition.value
          .map((v) => bind(v, values))
          .join(',')}))`;
  }
  if (condition.operator === 'some') {
    return `EXISTS (
        SELECT *
        FROM json_each(${sqlPath(condition.path)})
        WHERE json_extract(json_each.value, '$.' || ${escape(
          condition.condition.path
        )}) = ${bind(condition.condition.value, values)}
      )`;
  }
  if (condition.operator === 'isnull') {
    return `${sqlPath(condition.path)} IS NULL`;
  }
  if (condition.operator === 'isnotnull') {
    return `${sqlPath(condition.path)} IS NOT NULL`;
  }
  if (condition.operator === 'eq') {
    return `${sqlPath(condition.path)} = ${bind(condition.value, values)}`;
  }
  if (condition.operator === 'gte') {
    return `${sqlPath(condition.path)} >= ${bind(condition.value, values)}`;
  }
  if (condition.operator === 'gt') {
    return `${sqlPath(condition.path)} > ${bind(condition.value, values)}`;
  }
  if (condition.operator === 'lte') {
    return `${sqlPath(condition.path)} <= ${bind(condition.value, values)}`;
  }
  if (condition.operator === 'lt') {
    return `${sqlPath(condition.path)} < ${bind(condition.value, values)}`;
  }
  if (condition.operator === 'neq') {
    return `${sqlPath(condition.path)} <> ${bind(condition.value, values)}`;
  }
  if (condition.operator === 'in') {
    return `${sqlPath(condition.path)} IN (${condition.value
      .map((v) => bind(v, values))
      .join(',')})`;
  }
  if (condition.operator === 'nin') {
    return `${sqlPath(condition.path)} NOT IN (${condition.value
      .map((v) => bind(v, values))
      .join(',')})`;
  }
  if (condition.operator === 'and') {
    return `(${condition.conditions
      .map((cond) => sqlCondition(cond, values))
      .join(' AND ')})`;
  }
  if (condition.operator === 'or') {
    return `(${condition.conditions
      .map((cond) => sqlCondition(cond, values))
      .join(' OR ')})`;
  }
  throw new Error(`Unsupported operator '${condition.operator}'`);
}

class CryoReader extends SQLite {
  constructor(location, db, handle) {
    super(location);

    this._queries = {};
    this._dbName = db;
    this._handle = handle;

    this._queries.getGoblinState = `
      SELECT json_extract(action, '$.payload.state') as action
      FROM actions
      WHERE goblin = $goblin
        AND type = $type
      ORDER BY rowid DESC
      LIMIT 1;
    `;

    this._queries.getGoblinIds = `
      SELECT substr(goblin,  instr(goblin,'-') + 1) AS goblinId
      FROM actions
      WHERE goblin LIKE $goblin
        AND type = $type
      GROUP BY goblin
    `;

    this._queries.hasPersistedGoblin = `
      SELECT 'true' as exist
      FROM actions
      WHERE goblin = $goblin
        AND type = 'persist'
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
  }

  _open(dbName, resp) {
    const res = super.open(dbName, '', this._queries, null, null, null, {
      readonly: true,
    });
    if (!res) {
      resp.log.warn('something wrong happens with SQLite');
    }
    return res;
  }

  getGoblinState(quest, goblinId, type = 'persist') {
    if (!this.tryToUse(quest)) {
      return null;
    }

    if (!this._open(this._dbName, quest)) {
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

  *getGoblinIds(quest, goblinPattern, type = 'persist') {
    if (!this.tryToUse(quest)) {
      return [];
    }

    if (!this._open(this._dbName, quest)) {
      return [];
    }

    for (const {goblinId} of this.stmts(this._dbName).getGoblinIds.iterate({
      goblin: goblinPattern,
      type,
    })) {
      yield goblinId;
    }
  }

  *queryLastActions(
    quest,
    goblinType,
    properties,
    filters = undefined,
    orderBy = undefined
  ) {
    if (!this.tryToUse(quest)) {
      return [];
    }

    if (!this._open(this._dbName, quest)) {
      return [];
    }

    goblinType = `${goblinType}-%`;

    const select = properties
      .map((path) => `${sqlPath(path)} as ${escape(path)}`)
      .join(',');

    const values = [goblinType];
    let sql = `
      SELECT ${select}
      FROM lastPersistedActions
      WHERE goblin LIKE ?`;

    if (filters) {
      sql += ` AND (${sqlCondition(filters, values)})`;
    }

    if (orderBy) {
      const orderSql = Object.entries(orderBy)
        .map(([path, order]) => `${sqlPath(path)} ${order}`)
        .join(',');
      sql = `${sql}
      ORDER BY ${orderSql}`;
    }

    const statement = this.prepare(this._dbName, sql);
    for (const res of statement.iterate(values)) {
      yield res;
    }
  }

  pickAction(quest, id, properties) {
    if (!this.tryToUse(quest)) {
      return null;
    }

    if (!this._open(this._dbName, quest)) {
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
    return stmt.get(values);
  }

  isPersisted(quest, goblinId) {
    if (!this.tryToUse(quest)) {
      return false;
    }

    if (!this._open(this._dbName, quest)) {
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

  commitStatus(quest, goblinId) {
    if (!this.tryToUse(quest)) {
      return false;
    }

    if (!this._open(this._dbName, quest)) {
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
