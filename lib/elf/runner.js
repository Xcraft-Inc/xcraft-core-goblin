'use strict';

const {Mutex} = require('xcraft-core-utils/lib/locks.js');
const {setTimeout} = require('node:timers/promises');

class Runner {
  #context = {
    self: {},
    mutex: new Mutex(),
  };
  #tests;

  constructor() {}

  init() {
    const run = require('xcraft-core-host/lib/host.js');
    let ctx = this.#context;
    async function start() {
      ctx.self = this;
      await ctx.mutex.lock();
    }
    run(start);
  }

  dispose() {
    this.#context.mutex.unlock();
    this.#context.self.quest.cmd('shutdown');
  }

  async #load() {
    if (this.#tests) {
      return;
    }
    while (!this.#context.mutex.isLocked) {
      await setTimeout(500, () => {});
    }
  }

  async it(callback) {
    await this.#load();
    await callback.call(this.#context.self);
  }
}

module.exports = Runner;
