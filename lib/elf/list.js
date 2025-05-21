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

  get toJS() {
    return this._state.state
      .getIn(this._path)
      .toJS.bind(this._state.state.getIn(this._path));
  }

  push(...args) {
    return this._state.state.updateIn(this._path, (list) =>
      list.push(...args.map((arg) => Shredder.toImmutable(arg)))
    );
  }

  map(func) {
    return this._state.state
      .getIn(this._path)
      .map((value, ...args) => func(value.toJS ? value.toJS() : value, ...args))
      .toJS();
  }

  deleteByValue(value) {
    const index = this.indexOf(value);
    if (index === -1) {
      return this._state.state;
    }
    return this._state.state.updateIn(this._path, (list) => list.delete(index));
  }

  indexOf(value) {
    return this._state.state.getIn(this._path).indexOf(value);
  }

  includes(...args) {
    return this._state.state.getIn(this._path).includes(...args);
  }
}

module.exports = List;
