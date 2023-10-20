'use strict';

const CryoReader = require('./reader.js');
const CryoSearch = require('./search.js');

class CryoManager {
  #readers = {};
  #indexers = {};

  constructor() {}

  async #tryCryoReader(quest, db) {
    const cryo = quest.getAPI('cryo');
    const location = await cryo.getLocation();
    await cryo.migrate({db});
    return new CryoReader(location, db);
  }

  async #tryCryoSearch(quest, db) {
    const cryo = quest.getAPI('cryo');
    const location = await cryo.getLocation();
    await cryo.migrate({db});
    return new CryoSearch(location, db);
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

  async getState(quest, db, goblinId, type, source) {
    const reader = await this.reader(quest, db);
    return reader ? reader.getGoblinState(quest, goblinId, type, source) : null;
  }

  async getIds(quest, db, goblinPattern, type, source) {
    const reader = await this.reader(quest, db);
    return reader
      ? reader.getGoblinIds(quest, goblinPattern, type, source)
      : [];
  }

  async queryLastActions(quest, db, goblinType, properties, filters) {
    const reader = await this.reader(quest, db);
    return reader
      ? reader.queryLastActions(quest, goblinType, properties, filters)
      : [];
  }
}

module.exports = new CryoManager();
