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

    this._queries.searchDistance = `
      SELECT locale, scope, documentId, chunkId, chunk, distance 
      FROM embeddings
      WHERE embedding match $vectors 
      ORDER BY distance LIMIT $limit
    `;

    this._queries.searchDistance2 = `
      SELECT locale, scope, documentId, chunkId, chunk, distance 
      FROM embeddings
      WHERE embedding match $vectors AND
      locale = $locale AND
      scope = $scope
      ORDER BY distance
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

  *searchDistance(vectors, limit = 100) {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    for (const {
      locale,
      scope,
      documentId,
      chunkId,
      chunk,
      distance,
    } of this.stmts(this._dbName).searchDistance.iterate({
      vectors: new Float32Array(vectors),
      limit,
    })) {
      yield {locale, scope, documentId, chunkId, chunk, distance};
    }
  }

  *searchDistance2(vectors, locale, scope, limit = 100) {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    for (const row of this.stmts(this._dbName).searchDistance2.iterate({
      locale,
      scope,
      vectors: new Float32Array(vectors),
      limit,
    })) {
      yield row;
    }
  }

  /**
   * Raw extraction of strings in actions
   * @yields
   * @param {string} pattern to search (static part)
   * @param {RegExp} regex used to extract from the action
   * @param {boolean} lastOnly use lastPersistedActions table
   * @returns {Iterable<string>}
   */
  *searchRaw(pattern, regex, lastOnly = true) {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    if (pattern.includes("'")) {
      throw new Error('Bad pattern, simple quote detected');
    }

    let sql;
    if (lastOnly) {
      sql = `
        SELECT action
          FROM lastPersistedActions
        WHERE action GLOB '${pattern}';
      `;
    } else {
      sql = `
        SELECT actions.action AS action
          FROM actions, lastPersistedActions
        WHERE actions.goblin = lastPersistedActions.goblin
          AND actions.action GLOB '${pattern}';
      `;
    }

    const stmt = this.prepare(this._dbName, sql);
    for (const {action} of stmt.iterate()) {
      yield [...action.matchAll(regex)].map(([, res]) => res);
    }
  }
}

module.exports = CryoSearch;
