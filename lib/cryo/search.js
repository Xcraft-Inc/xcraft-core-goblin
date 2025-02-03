'use strict';

const {SQLite} = require('xcraft-core-book');

class CryoSearch extends SQLite {
  constructor(location, db, getHandle) {
    super(location);

    this._queries = {};
    this._dbName = db;
    this._getHandle = getHandle;

    this._queries.search = `
      SELECT substr(goblin, pos + 1) AS goblinId
      FROM (
        SELECT distinct(goblin), instr(goblin,'-') AS pos
        FROM lastPersistedActions
        WHERE rowid IN (
          SELECT rowid
          FROM fts_idx fi
          WHERE fts_idx MATCH $searchQuery
          ORDER BY rank
        )
      )
      LIMIT $limit
    `;
  }

  _open(dbName, resp) {
    const res = super.open(dbName, '', this._queries);
    if (!res) {
      resp.log.warn('something wrong happens with SQLite');
    }
    return res;
  }

  *search(searchQuery, limit = 100) {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    for (const {goblinId} of this.stmts(this._dbName).search.iterate({
      searchQuery,
      limit,
    })) {
      yield goblinId;
    }
  }

  /**
   * Raw extraction of strings in actions
   * @yields
   * @param {string} pattern to search (static part)
   * @param {RegExp} regex used to extract from the action
   * @returns {Iterable<string>}
   */
  *searchRaw(pattern, regex) {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    if (pattern.includes("'")) {
      throw new Error('Bad pattern, simple quote detected');
    }

    const sql = `
      SELECT action
      FROM lastPersistedActions
      WHERE action GLOB '*${pattern}*';
    `;
    const stmt = this.prepare(this._dbName, sql);
    for (const {action} of stmt.iterate()) {
      yield action.match(regex);
    }
  }
}

module.exports = CryoSearch;
