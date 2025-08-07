'use strict';

const debounce = require('lodash/debounce');
const CryoReader = require('./reader.js');
const CryoSearch = require('./search.js');
const goblinConfig = require('xcraft-core-etc')().load('xcraft-core-goblin');

const notifiers = {};

class CryoManager {
  #readers = {};
  #indexers = {};

  constructor() {}

  async #try(quest, db) {
    const Goblin = require('xcraft-core-goblin');
    const Goblins = Goblin.getGoblinsRegistry();

    const cryo = require('xcraft-core-cryo');
    const cryoAPI = quest.getAPI('cryo');

    /* We try with the cryo handle first. The goal is to be sure
     * that we cannot generate deadlocks by using an other connection
     * on the database while a sync with an immediate transaction is
     * running. With one process, we should use the same connection
     * most of time while using the DELETE journal (client side).
     */
    const success = await cryoAPI.init({db});
    if (success) {
      const getHandle = cryo.getHandle(db);
      if (getHandle) {
        return {
          getHandle,
          location: Goblins.has('cryo')
            ? cryo.getLocation()
            : await cryoAPI.getLocation(),
        };
      }
    }

    /* This fallback will use a read-only connection, but it can be
     * a problem (deadlock) if we wrap the reader in a third immediate
     * transaction.
     */
    return {
      getHandle: null,
      location: await cryoAPI.getLocation(),
    };
  }

  async #tryCryoReader(quest, db) {
    const {getHandle, location} = await this.#try(quest, db);
    return new CryoReader(location, db, getHandle, quest);
  }

  async #tryCryoSearch(quest, db) {
    const {getHandle, location} = await this.#try(quest, db);
    return new CryoSearch(location, db, getHandle, quest);
  }

  async reader(quest, db) {
    db = db || quest.getSession();
    if (!this.#readers[db]) {
      this.#readers[db] = await this.#tryCryoReader(quest, db);
    }
    return this.#readers[db];
  }

  async fullTextSearcher(quest, db) {
    db = db || quest.getSession();
    if (!this.#indexers[db]) {
      this.#indexers[db] = await this.#tryCryoSearch(quest, db);
    }
    return this.#indexers[db];
  }

  async search(quest, db, searchQuery, limit) {
    const fullTextSearcher = await this.fullTextSearcher(quest, db);
    return fullTextSearcher ? fullTextSearcher.search(searchQuery, limit) : [];
  }

  async search2(quest, db, searchQuery, locales, scopes, limit) {
    const fullTextSearcher = await this.fullTextSearcher(quest, db);
    return fullTextSearcher
      ? fullTextSearcher.search2(searchQuery, locales, scopes, limit)
      : [];
  }

  async searchDistance(quest, db, vectors, limit) {
    const fullTextSearcher = await this.fullTextSearcher(quest, db);
    return fullTextSearcher
      ? fullTextSearcher.searchDistance(vectors, limit)
      : [];
  }

  async searchDistance2(quest, db, vectors, locales, scopes, limit) {
    const fullTextSearcher = await this.fullTextSearcher(quest, db);
    return fullTextSearcher
      ? fullTextSearcher.searchDistance2(vectors, locales, scopes, limit)
      : [];
  }

  async getDistinctScopes(quest, db) {
    const fullTextSearcher = await this.fullTextSearcher(quest, db);
    return fullTextSearcher ? fullTextSearcher.getDistinctScopes() : [];
  }

  async *searchRaw(quest, db, pattern, regex, lastOnly) {
    const fullTextSearcher = await this.fullTextSearcher(quest, db);
    return fullTextSearcher
      ? yield* fullTextSearcher.searchRaw(pattern, regex, lastOnly)
      : yield [];
  }

  async getState(quest, db, goblinId, shape, type) {
    const reader = await this.reader(quest, db);
    return reader ? reader.getGoblinState(goblinId, type) : null;
  }

  async getIds(quest, db, goblinType, options) {
    const reader = await this.reader(quest, db);
    return reader ? reader.getGoblinIds(goblinType, options) : [];
  }

  async queryLastActions(quest, db, goblinType, properties, filters, orderBy) {
    const reader = await this.reader(quest, db);
    return reader
      ? reader.queryLastActions(goblinType, properties, filters, orderBy)
      : [];
  }

  async pickAction(quest, db, id, properties) {
    const reader = await this.reader(quest, db);
    return reader ? reader.pickAction(id, properties) : [];
  }

  async isPersisted(quest, db, goblinId) {
    const reader = await this.reader(quest, db);
    return reader ? reader.isPersisted(goblinId) : false;
  }

  async isPublished(quest, db, goblinId) {
    const reader = await this.reader(quest, db);
    return reader ? reader.isPublished(goblinId) : false;
  }

  async commitStatus(quest, db, goblinId) {
    const reader = await this.reader(quest, db);
    return reader ? reader.commitStatus(goblinId) : false;
  }

  syncBroadcast(db) {
    if (goblinConfig.actionsSync?.excludeDB?.includes(db)) {
      return;
    }
    if (!notifiers[db]) {
      const busClient = require('xcraft-core-busclient').getGlobal();
      const resp = busClient.newResponse('cryoManager', 'token');
      notifiers[db] = debounce(
        () => resp.events.send('cryo-db-synced', {db, _xcraftRPC: true}),
        500
      );
    }
    notifiers[db]();
  }
}

module.exports = new CryoManager();
