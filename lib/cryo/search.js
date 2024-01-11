'use strict';

const {SQLite} = require('xcraft-core-book');

class CryoSearch extends SQLite {
  constructor(location, db) {
    super(location);

    this._queries = {};
    this._dbName = db;

    this._queries.search = `
      SELECT substr(goblin, pos + 1) AS goblinId
      FROM (
        SELECT distinct(goblin), instr(goblin,'-') AS pos, action
        FROM lastPersistedActions
        WHERE rowid IN (
          SELECT rowid
          FROM fts_idx fi
          WHERE fts_idx MATCH $searchQuery
          ORDER BY rank
        )
      )
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

  *search(quest, searchQuery) {
    if (!this.tryToUse(quest)) {
      return [];
    }

    if (!this._open(this._dbName, quest)) {
      return [];
    }

    for (const {goblinId} of this.stmts(this._dbName).search.iterate({
      searchQuery,
    })) {
      yield goblinId;
    }
  }
}

module.exports = CryoSearch;
