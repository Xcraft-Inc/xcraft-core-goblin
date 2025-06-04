'use strict';

const {appConfigPath} = require('xcraft-core-host');
const {setTimeout: setTimeoutAsync} = require('node:timers/promises');
const fse = require('fs-extra');
const Me = require('./me.js');

class Runner {
  static #context = {
    self: null,
  };
  static #initialized = false;
  static #timeout = null;

  constructor() {}

  init() {
    if (Runner.#timeout) {
      clearTimeout(Runner.#timeout);
      Runner.#timeout = null;
    }
    if (Runner.#context.self) {
      return;
    }
    if (appConfigPath.endsWith('-test')) {
      fse.removeSync(appConfigPath);
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
    Runner.#timeout = setTimeout(() => process.exit(0), 2000).unref();
    // FIXME: it's a problem when mocha is running multiple tests that needs
    //        the Xcraft server then we must disable the shutdown.
    if (process.env.GOBLIN_RUNNER_SHUTDOWN === 'no') {
      return;
    }
    Runner.#context.self.quest.cmd('shutdown');
  }

  async #load() {
    while (!Runner.#initialized) {
      await setTimeoutAsync(500);
    }
  }

  async it(callback) {
    await this.#load();
    const me = new Me(Runner.#context.self.quest);
    await callback.bind(me)(Runner.#context.self.quest);
  }
}

module.exports = Runner;
