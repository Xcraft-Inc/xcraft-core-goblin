const debounce = require('lodash/debounce');

class Sync {
  #hordesSync;
  #sync;
  #syncDB = {};

  constructor() {
    this.#hordesSync = require('./hordesSync.js')();
    this.#sync = debounce(() => this.#hordesSync.sync(), 500);
  }

  sync(db, id) {
    this.#hordesSync.set(db, id);
    this.#sync();
  }

  syncDB(db) {
    if (!this.#syncDB[db]) {
      this.#syncDB[db] = debounce(() => this.#hordesSync.syncDB(db), 500);
    }
    this.#syncDB[db]();
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
