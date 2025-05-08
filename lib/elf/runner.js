'use strict';

const {setTimeout: setTimeoutAsync} = require('node:timers/promises');

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
    //        the Xcraft server then we must disable the shutdown.
    if (process.env.GOBLIN_RUNNER_SHUTDOWN === 'no') {
      return;
    }
    Runner.#context.self.quest.cmd('shutdown');
    setTimeout(() => process.exit(0), 1000).unref();
  }

  async #load() {
    while (!Runner.#initialized) {
      await setTimeoutAsync(500);
    }
  }

  async it(callback) {
    await this.#load();
    await callback.call(Runner.#context.self);
  }
}

module.exports = Runner;
