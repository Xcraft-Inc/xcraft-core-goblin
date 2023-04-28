const Shredder = require('xcraft-core-shredder');

/**
 * Elf's reducers based on Shredder.
 *
 * This class offers traps on Stone's states that translates natural
 * javascript object manipulations into immutable.js data structure.
 */
class Spirit {
  static #log = require('xcraft-core-log')('spirit');

  _state = new Shredder();
  _immState;

  /**
   * @returns {object} javascript object from the immutable state
   */
  toJS() {
    return this._state.toJS();
  }

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
}

module.exports = Spirit;
