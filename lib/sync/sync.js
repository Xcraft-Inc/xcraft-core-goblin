const debounce = require('lodash/debounce');

class Sync {
  #hordesSync;
  #sync;
  #syncDB;

  constructor() {
    this.#hordesSync = require('./hordesSync.js')();
    this.#sync = debounce(() => this.#hordesSync.sync(), 500);
    this.#syncDB = debounce((db) => this.#hordesSync.syncDB(db), 500);
  }

  sync(db, id) {
    this.#hordesSync.set(db, id);
    this.#sync();
  }

  async syncDB(db) {
    await this.#syncDB(db);
  }
}

/** @type {Sync} */
let sync;

module.exports = () => {
  if (!sync) {
    sync = new Sync();
  }
  return sync;
};
