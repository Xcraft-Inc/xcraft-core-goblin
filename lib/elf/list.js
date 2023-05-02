'use strict';

const Shredder = require('xcraft-core-shredder');

/**
 * Wrapper for the arrays used on a Elf's state.
 */
class List {
  /** Root state */
  _state;

  /**
   * Absolute path for the array
   *
   * @private
   */
  _path;

  constructor(state, path) {
    this._state = state;
    this._path = path;

    const it = this._state.state.getIn(this._path).values();
    this[Symbol.iterator] = it[Symbol.iterator].bind(it);
  }

  get length() {
    return this._state.state.getIn(this._path).size;
  }

  push(...args) {
    return this._state.state.updateIn(this._path, (list) =>
      list.push(...args.map((arg) => Shredder.toImmutable(arg)))
    );
  }

  includes(...args) {
    return this._state.state.getIn(this._path).includes(...args);
  }
}

module.exports = List;
