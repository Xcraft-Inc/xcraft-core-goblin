'use strict';

const Shredder = require('xcraft-core-shredder');
const {stateTraps} = require('./traps.js');

/**
 * Elf's reducers based on Shredder.
 *
 * This class offers traps on Stone's states that translates natural
 * javascript object manipulations into immutable.js data structure.
 */
class Spirit {
  static #log = require('xcraft-core-log')('spirit');
  static traps = stateTraps;

  _state = new Shredder();
  /** @private */
  _immState;

  /**
   * @returns {Shredder} immutable Shredder state
   */
  get immutable() {
    return this._immState;
  }

  /**
   * @returns {*} Xcraft logger
   */
  get log() {
    return Spirit.#log;
  }

  /**
   * @template T
   * @param {T} sculptedClass
   * @returns {(shredder: Shredder) => InstanceType<T>}
   */
  static from(sculptedClass) {
    return (shredder) => {
      let sculpted = new sculptedClass();
      sculpted._state = shredder;
      sculpted.toJS = shredder.toJS.bind(shredder);
      return new Proxy(sculpted, Spirit.traps);
    };
  }
}

module.exports = Spirit;
