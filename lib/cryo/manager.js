'use strict';

const CryoReader = require('./reader.js');

class CryoManager {
  #readers = {};
  #db;

  constructor(db) {
    if (db) {
      this.#db = db;
    }
  }

  async #tryCryo(quest) {
    const cryo = quest.getAPI('cryo');
    const location = await cryo.getLocation();
    return new CryoReader(location, quest.getSession());
  }

  async reader(quest) {
    const db = this.#db || quest.getSession();
    if (!this.#readers[db]) {
      this.#readers[db] = await this.#tryCryo(quest);
    }
    return this.#readers[db];
  }

  async getState(quest, goblinId, type, source) {
    const reader = await this.reader(quest);
    return reader ? reader.getGoblinState(quest, goblinId, type, source) : null;
  }

  async getIds(quest, goblinPattern, type, source) {
    const reader = await this.reader(quest);
    return reader
      ? reader.getGoblinIds(quest, goblinPattern, type, source)
      : [];
  }
}

module.exports = new CryoManager();
