'use strict';

const debounce = require('lodash/debounce');
const CryoReader = require('./reader.js');
const CryoSearch = require('./search.js');

const notifiers = {};

class CryoManager {
  #readers = {};
  #indexers = {};

  constructor() {}

  async #try(quest, db) {
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
      const handle = cryo.getHandle(db);
      if (handle) {
        return {
          handle,
          location: cryo.getLocation(),
        };
      }
    }

    /* This fallback will use a read-only connection, but it can be
     * a problem (deadlock) if we wrap the reader in a third immediate
     * transaction.
     */
    return {
      handle: null,
      location: await cryoAPI.getLocation(),
    };
  }

  async #tryCryoReader(quest, db) {
    const {handle, location} = await this.#try(quest, db);
    return new CryoReader(location, db, handle);
  }

  async #tryCryoSearch(quest, db) {
    const {handle, location} = await this.#try(quest, db);
    return new CryoSearch(location, db, handle);
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

  async search(quest, db, searchQuery) {
    const fullTextSearcher = await this.fullTextSearcher(quest, db);
    return fullTextSearcher ? fullTextSearcher.search(quest, searchQuery) : [];
  }

  async extractBlob(quest, db, id, destPathFolder) {
    const reader = await this.reader(quest, db);
    return reader ? reader.extractBlob(quest, id, destPathFolder) : null;
  }

  async getState(quest, db, goblinId, type) {
    const reader = await this.reader(quest, db);
    return reader ? reader.getGoblinState(quest, goblinId, type) : null;
  }

  async getIds(quest, db, goblinPattern, type) {
    const reader = await this.reader(quest, db);
    return reader ? reader.getGoblinIds(quest, goblinPattern, type) : [];
  }

  async queryLastActions(quest, db, goblinType, properties, filters, orderBy) {
    const reader = await this.reader(quest, db);
    return reader
      ? reader.queryLastActions(quest, goblinType, properties, filters, orderBy)
      : [];
  }

  async isPersisted(quest, db, goblinId) {
    const reader = await this.reader(quest, db);
    return reader ? reader.isPersisted(quest, goblinId) : false;
  }

  syncBroadcast(quest, db) {
    if (!notifiers[db]) {
      const resp = quest.newResponse('cryoManager', 'token');
      notifiers[db] = debounce(
        () => resp.events.send('cryo-db-synced', {db, _xcraftRPC: true}),
        500
      );
    }
    notifiers[db]();
  }
}

module.exports = new CryoManager();
