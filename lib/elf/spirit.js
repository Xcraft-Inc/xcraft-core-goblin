'use strict';

const Shredder = require('xcraft-core-shredder');
const List = require('./list.js');

/**
 * Traps dedicated to the Elf's reducers.
 */
const stateTraps = {
  get(state, prop) {
    if (prop.startsWith('_') || typeof state[prop] === 'function') {
      return Reflect.get(...arguments);
    }

    if (Array.isArray(state[prop])) {
      return new List(state._state, state?._path?.concat(prop) || [prop]);
    }

    if (state[prop] !== null && typeof state[prop] === 'object') {
      const _path = state._path || [];
      _path.push(prop);
      return new Proxy(
        {_state: state._state, _path, ...state[prop]},
        stateTraps
      );
    }

    const value = state._state.get(state?._path?.concat(prop) || [prop]);
    if (value?._isSuperReaper6000) {
      const _path = state?._path?.concat(prop) || [prop];
      return new Proxy({_state: state._state, _path}, stateTraps);
    }
    return value;
  },
  set(state, prop, value) {
    if (prop.startsWith('_') || typeof state[prop] === 'function') {
      Reflect.set(...arguments);
      return true;
    }
    if (!state._state) {
      state._state = new Shredder();
    }
    state._state = state._state.set(
      state?._path?.concat(prop) || [prop],
      value
    );
    return true;
  },
  deleteProperty(state, prop) {
    if (prop in state) {
      state._state.state.deleteIn(state?._path?.concat(prop) || [prop]);
      return true;
    }
  },
};

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
