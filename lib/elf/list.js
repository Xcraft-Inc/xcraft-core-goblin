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
