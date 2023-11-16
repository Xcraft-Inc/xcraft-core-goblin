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
    return condition.conditions
      .map((cond) => sqlCondition(cond, values))
      .join(' AND ');
  }
  if (condition.operator === 'or') {
    return condition.conditions
      .map((cond) => sqlCondition(cond, values))
      .join(' OR ');
  }
  throw new Error(`Unsupported operator '${condition.operator}'`);
}

class CryoReader extends SQLite {
  constructor(location, db) {
    super(location);

    this._queries = {};
    this._dbName = db;

    this._queries.getGoblinState = `
      SELECT json_extract(action, '$.payload.state') as action
      FROM actions
      WHERE goblin = $goblin
        AND type = $type
        AND source = $source
      ORDER BY timestamp DESC
      LIMIT 1;
    `;

    this._queries.getGoblinIds = `
      SELECT substr(goblin,  instr(goblin,'-') + 1) AS goblinId
      FROM actions
      WHERE goblin LIKE $goblin
        AND type = $type
        AND source = $source
      GROUP BY goblin
    `;

    this._queries.getBlobMeta = `
      SELECT meta
      FROM blobs
      WHERE id = $id
    `;

    this._queries.getBlob = `
      SELECT blob
      FROM blobs
      WHERE id = $id
    `;

    this._queries.hasPersistedGoblin = `
      SELECT 'true' as exist
      FROM lastPersistedActions l
      WHERE l.goblin = $goblin
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

  getGoblinState(quest, goblinId, type = 'persist', source = 'local') {
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
      source,
    });
    if (!result) {
      return null;
    }
    if (!result.action) {
      return null;
    }
    return JSON.parse(result.action);
  }

  *getGoblinIds(quest, goblinPattern, type = 'persist', source = 'local') {
    if (!this.tryToUse(quest)) {
      return [];
    }

    if (!this._open(this._dbName, quest)) {
      return [];
    }

    for (const {goblinId} of this.stmts(this._dbName).getGoblinIds.iterate({
      goblin: goblinPattern,
      type,
      source,
    })) {
      yield goblinId;
    }
  }

  *queryLastActions(quest, goblinType, properties, filters) {
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
    const sql = `
    SELECT ${select}
    FROM lastPersistedActions
    WHERE goblin LIKE ? AND ${sqlCondition(filters, values)}`;

    const statement = this.prepare(this._dbName, sql);
    for (const res of statement.iterate(values)) {
      yield res;
    }
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

  /**
   *
   * @param {*} quest
   * @param {*} id identifier of the blob
   * @param {*} destPathFolder user chosen folder where the blob is extracted
   */
  extractBlob(quest, id, destPathFolder) {
    if (!this._open(this._dbName, quest)) {
      return;
    }
    let {meta} = this.stmts(this._dbName).getBlobMeta.get({id});
    meta = JSON.parse(meta);
    let fileName = meta?.name || `${id}.blob`;
    fileName = this.normalizeFileName(fileName);
    const xFs = require('xcraft-core-fs');
    const path = require('path');
    const {blob} = this.stmts(this._dbName).getBlob.get({id});
    xFs.fse.writeFileSync(path.join(destPathFolder, fileName), blob);
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
