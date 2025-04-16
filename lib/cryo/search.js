'use strict';

const {SQLite} = require('xcraft-core-book');

class CryoSearch extends SQLite {
  constructor(location, db, getHandle) {
    super(location);

    this._queries = {};
    this._dbName = db;
    this._getHandle = getHandle;

    const cryoConfig = require('xcraft-core-etc')().load('xcraft-core-cryo');

    if (
      cryoConfig.enableFTS &&
      (cryoConfig.fts.list.length === 0 || cryoConfig.fts.list.includes(db))
    ) {
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
      this._queries.search2 = `
        SELECT substr(goblin, pos + 1) AS goblinId, locale, scope, data
        FROM (
          SELECT distinct(goblin), instr(goblin,'-') AS pos,
		      IFNULL(json_extract(action,'$.payload.state.meta.locale'),'fr') as locale,
		      json_extract(action,'$.payload.state.meta.scope') as scope,
          json_extract(action,'$.payload.state.meta.index') as data
          FROM lastPersistedActions action
          WHERE rowid IN (
            SELECT rowid
            FROM fts_idx fi
            WHERE fts_idx MATCH $searchQuery
            ORDER BY rank
          )
        )
		    WHERE locale IN (SELECT value FROM json_each($locales)) AND scope IN (SELECT value FROM json_each($scopes))
        LIMIT $limit
      `;
    }

    if (
      cryoConfig.enableVEC &&
      (cryoConfig.vec.list.length === 0 || cryoConfig.vec.list.includes(db))
    ) {
      this._queries.searchDistance = `
        SELECT locale, scope, documentId, chunkId, chunk, distance
        FROM embeddings
        WHERE embedding match $vectors
        AND k = $limit
        ORDER BY distance
      `;

      //We cannot use IN operator with sqlite-vec
      //this query use some tricks
      this._queries.searchDistance2 = `
        WITH locales AS (
          SELECT value AS locale FROM json_each($locales)
        ),
        scopes AS (
          SELECT value AS scope FROM json_each($scopes)
        )
        SELECT e.locale, e.scope, e.documentId, e.chunkId, e.chunk, e.distance
        FROM embeddings e
        WHERE embedding MATCH $vectors
          AND EXISTS (
            SELECT 1 FROM locales WHERE locale = e.locale
          )
          AND EXISTS (
            SELECT 1 FROM scopes WHERE scope = e.scope
          )
          AND k = $limit
        ORDER BY distance
      `;
    }
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

  *search2(searchQuery, locales = [], scopes = [], limit = 100) {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    for (const {goblinId, locale, scope, data} of this.stmts(
      this._dbName
    ).search2.iterate({
      searchQuery,
      locales: JSON.stringify(locales),
      scopes: JSON.stringify(scopes),
      limit,
    })) {
      yield {documentId: goblinId, locale, scope, data};
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

  *searchDistance2(vectors, locales = [], scopes = [], limit = 100) {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    for (const row of this.stmts(this._dbName).searchDistance2.iterate({
      locales: JSON.stringify(locales),
      scopes: JSON.stringify(scopes),
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
