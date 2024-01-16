'use strict';

const {isList, isMap} = require('immutable');
const Shredder = require('xcraft-core-shredder');
const List = require('./list.js');

const mapTraps = {
  getOwnPropertyDescriptor(state, prop) {
    if (
      typeof prop === 'symbol' ||
      prop.startsWith('_') ||
      typeof state[prop] === 'function'
    ) {
      return Reflect.getOwnPropertyDescriptor(...arguments);
    }

    const _path = state._path || [];
    const isObj = isMap(state._state.state.getIn(_path));

    return isObj
      ? {enumerable: true, configurable: true}
      : Reflect.getOwnPropertyDescriptor(...arguments);
  },
  ownKeys(state) {
    const _path = state._path || [];
    return Array.from(state._state.state.getIn(_path).keys());
  },
};

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
        it = state._state.state
          .getIn(_path)
          .map((value) => {
            if (!Shredder.isImmutable(value) && !Shredder.isShredder(value)) {
              return value;
            }
            const shredder = new Shredder(value);
            const _value = {
              _state: shredder,
              toJS: shredder.state.toJS.bind(shredder.state.getIn(_path)),
            };
            return new Proxy(_value, stateTraps);
          })
          .values();
      } else {
        it = state._state.state.getIn(_path).entries();
      }
      return it[prop].bind(it);
    }

    if (state instanceof List) {
      const desc = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(state),
        prop
      );
      if (desc?.get) {
        return Reflect.get(...arguments);
      }
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
      return new Proxy(new List(state._state, _path), stateTraps);
    }

    const isObj = isMap(state._state.state.getIn(_path));
    if (isObj) {
      return new Proxy(
        {
          _state: state._state,
          _path,
          toJS: state._state.getIn(_path).toJS.bind(state._state.getIn(_path)),
          ...state[prop],
        },
        {...stateTraps, ...mapTraps}
      );
    }

    const value = state._state.get(_path);
    if (value?._isSuperReaper6000) {
      return new Proxy(
        {
          _state: state._state,
          _path,
          toJS: state._state.getIn(_path).toJS.bind(state._state.getIn(_path)),
        },
        stateTraps
      );
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
    state._state.state.deleteIn(state?._path?.concat(prop) || [prop]);
    return true;
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
