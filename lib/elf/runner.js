'use strict';

const {setTimeout} = require('node:timers/promises');

class Runner {
  static #context = {
    self: null,
  };
  static #initialized = false;

  constructor() {}

  init() {
    if (Runner.#context.self) {
      return;
    }
    const run = require('xcraft-core-host/lib/host.js');
    let ctx = Runner.#context;
    async function start() {
      ctx.self = this;
      Runner.#initialized = true;
    }
    run(start);
  }

  dispose() {
    // FIXME: it's a problem when mocha is running multiple tests that needs
    //        the Xcraft server.
    // Runner.#context.self.quest.cmd('shutdown');
  }

  async #load() {
    while (!Runner.#initialized) {
      await setTimeout(500);
    }
  }

  async it(callback) {
    await this.#load();
    await callback.call(Runner.#context.self);
  }
}

module.exports = Runner;
