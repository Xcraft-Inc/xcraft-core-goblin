'use strict';

const CryoReader = require('./reader.js');

class CryoManager {
  #readers = {};

  constructor() {}

  async #tryCryo(quest, db) {
    const cryo = quest.getAPI('cryo');
    const location = await cryo.getLocation();
    await cryo.migrate({db});
    return new CryoReader(location, db);
  }

  async reader(quest, db) {
    db = db || quest.getSession();
    if (!this.#readers[db]) {
      this.#readers[db] = await this.#tryCryo(quest, db);
    }
    return this.#readers[db];
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
}

module.exports = new CryoManager();