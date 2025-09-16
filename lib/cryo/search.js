'use strict';

const {SQLite} = require('xcraft-core-book');

class CryoSearch extends SQLite {
  #quest;

  constructor(location, db, getHandle, quest) {
    super(location);

    this.#quest = quest;
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
      WITH hits AS (
        SELECT rowid, rank AS raw_score
        FROM fts_idx
        WHERE fts_idx MATCH $searchQuery
      ),
      stats AS (
        SELECT MIN(raw_score) AS min_s, MAX(raw_score) AS max_s FROM hits
      ),
      meta AS (
        SELECT
          substr(a.goblin, instr(a.goblin,'-')+1) AS goblinId,
          IFNULL(json_extract(a.action,'$.payload.state.meta.locale'),'fr') AS locale,
          json_extract(a.action,'$.payload.state.meta.scope') AS scope,
          json_extract(a.action,'$.payload.state.meta.index') AS data,
          h.raw_score,
          s.max_s,
          s.min_s,
          (s.max_s - h.raw_score) / (s.max_s - s.min_s) AS norm_score
        FROM hits AS h
        JOIN stats AS s ON 1=1
        JOIN lastPersistedActions AS a ON h.rowid = a.rowid
      )
      SELECT goblinId, locale, scope, data, raw_score as rawScore, ROUND(norm_score, 4) AS normScore
      FROM meta
      WHERE locale IN (SELECT value FROM json_each($locales))
        AND scope IN (SELECT value FROM json_each($scopes))
      ORDER BY norm_score DESC
      LIMIT $limit;`;

      this._queries.getDistinctScopes = `SELECT DISTINCT
        json_extract(action, '$.payload.state.meta.scope') AS scope
        FROM lastPersistedActions
        WHERE json_extract(action, '$.payload.state.meta.scope') IS NOT NULL;`;
    }

    if (
      cryoConfig.enableVEC &&
      (cryoConfig.vec.list.length === 0 || cryoConfig.vec.list.includes(db))
    ) {
      const vecFunc = cryoConfig.vec.vecFunc;
      this._queries.searchDistance = `
        SELECT locale, scope, documentId, chunkId, chunk, distance
        FROM embeddings
        WHERE embedding match ${vecFunc}(unhex($vectors))
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
        WHERE embedding MATCH ${vecFunc}(unhex($vectors))
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

    for (const {
      goblinId,
      locale,
      scope,
      data,
      rawScore,
      normScore,
    } of this.stmts(this._dbName).search2.iterate({
      searchQuery,
      locales: JSON.stringify(locales),
      scopes: JSON.stringify(scopes),
      limit,
    })) {
      yield {documentId: goblinId, locale, scope, data, rawScore, normScore};
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
      vectors,
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
      vectors,
      limit,
    })) {
      yield row;
    }
  }

  /**
   * Get all possible scopes
   * @yields
   * @returns {Iterable<string>}
   */
  *getDistinctScopes() {
    if (!this.tryToUse()) {
      return [];
    }

    if (!this._open(this._dbName)) {
      return [];
    }

    for (const row of this.stmts(this._dbName).getDistinctScopes.iterate()) {
      yield row.scope;
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
