'use strict';

const {SQLite} = require('xcraft-core-book');

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
      SELECT substr(goblin, pos + 1) AS goblinId
      FROM (
        SELECT distinct(goblin), instr(goblin,'-') AS pos, type, source
        FROM actions
        GROUP BY goblin
      )
      WHERE goblin LIKE $goblin
        AND type = $type
        AND source = $source
    `;
  }

  _open(dbName, resp) {
    const res = super.open(dbName, '', this._queries);
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

    const {action} = this.stmts(this._dbName).getGoblinState.get({
      goblin: `${goblinId.split('@', 1)[0]}-${goblinId}`,
      type,
      source,
    });
    if (!action) {
      return null;
    }
    return JSON.parse(action);
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
}

module.exports = CryoReader;
