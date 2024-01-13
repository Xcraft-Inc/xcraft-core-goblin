const debounce = require('lodash/debounce');

class Sync {
  #hordesSync;
  #sync = {};

  constructor() {
    this.#hordesSync = require('./hordesSync.js')();
  }

  async wait() {
    await this.#hordesSync.wait();
  }

  sync(db) {
    if (!this.#sync[db]) {
      this.#sync[db] = debounce(() => this.#hordesSync.sync(db), 500);
    }
    this.#sync[db]();
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
