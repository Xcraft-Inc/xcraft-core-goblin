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
      SELECT documentId, chunkId, distance 
      FROM embeddings768 
      WHERE embedding match $vectors 
      ORDER BY distance LIMIT $limit
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

    for (const {documentId, chunkId, distance} of this.stmts(
      this._dbName
    ).searchDistance.iterate({
      vectors: new Float32Array(vectors),
      limit,
    })) {
      yield {documentId, chunkId, distance};
    }
  }
}

module.exports = CryoSearch;
