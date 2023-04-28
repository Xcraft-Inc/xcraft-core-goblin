'use strict';

const {isList, isMap} = require('immutable');
const Shredder = require('xcraft-core-shredder');
const List = require('./list.js');

/**
 * Traps dedicated to the Elf's reducers.
 */
const stateTraps = {
  get(state, prop) {
    const _path = state._path?.slice() || [];

    /* for..of */
    if (prop === Symbol.iterator) {
      let it;
      const isArray = isList(state._state.state.getIn(_path));
      if (isArray) {
        /* Shoud not be used, because it's wrapper in List */
        it = state._state.state.getIn(_path).values();
      } else {
        it = state._state.state.getIn(_path).entries();
      }
      return it[prop].bind(it);
    }

    if (
      typeof prop === 'symbol' ||
      prop.startsWith('_') ||
      typeof state[prop] === 'function'
    ) {
      return Reflect.get(...arguments);
    }

    _path.push(prop);
    const isArray = isList(state._state.state.getIn(_path));

    if (isArray) {
      return new List(state._state, _path);
    }

    const isObj = isMap(state._state.state.getIn(_path));
    if (isObj) {
      return new Proxy(
        {_state: state._state, _path, ...state[prop]},
        stateTraps
      );
    }

    const value = state._state.get(_path);
    if (value?._isSuperReaper6000) {
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
  /** @private */
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

  /**
   * @template T
   * @param {T} sculptedClass
   * @returns {(shredder: Shredder) => InstanceType<T>}
   */
  static from(sculptedClass) {
    return (shredder) => {
      let sculpted = new sculptedClass();
      sculpted._state = shredder;
      return new Proxy(sculpted, Spirit.traps);
    };
  }
}

module.exports = Spirit;
