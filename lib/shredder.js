'use strict';

const {isImmutable, fromJS} = require ('immutable');
const _ = require ('lodash');

class Shredder {
  constructor (initialState) {
    this._initialState = Object.assign ({}, initialState);
    this._useLogger = false;

    if (!isImmutable (initialState)) {
      this._state = fromJS (this._initialState);
      return;
    }
    this._state = this._initialState;
  }

  _clone () {
    const nShredder = new Shredder (this._state);
    nShredder._useLogger = this._useLogger;
    nShredder._logger = this._logger;
    return nShredder;
  }

  get state () {
    return this._state;
  }

  get useLogger () {
    return this._useLogger;
  }

  get log () {
    if (this.useLogger && this._logger) {
      return this._logger;
    }

    throw new Error ('No logger configured for this Shredder');
  }

  attachLogger (logger) {
    if (logger) {
      logger.verb ('Logger attached!');
      this._logger = logger;
      this._initialState.log = this._logger;
    }
  }

  enableLogger () {
    this._useLogger = true;
  }

  disableLogger () {
    this._useLogger = false;
  }

  forEach (...args) {
    this.state.forEach (...args);
  }

  includes (...args) {
    const isIncluding = this.state.includes (...args);
    if (this.useLogger) {
      this.log.verb (`state is including:\n${isIncluding}`);
    }
    return isIncluding;
  }

  equals (...args) {
    const isEqual = this.state.equals (...args);
    if (this.useLogger) {
      this.log.verb (`state is equals:\n${isEqual}`);
    }
    return isEqual;
  }

  filter (...args) {
    const nextState = this.state.filter (...args);
    if (this.useLogger) {
      this.log.verb (
        `next state after filter:\n${this._stateView (nextState)}`
      );
    }
    const nShredder = this._clone ();
    nShredder._state = nextState;
    return nShredder;
  }

  set (path, value) {
    this._protectShredderTools (this._pathShredder (path));
    const nextState = this.state.setIn (_.toPath (path), fromJS (value));
    if (this.useLogger) {
      this.log.verb (
        `next state after set ${path}:\n${this._stateView (nextState)}`
      );
    }
    const nShredder = this._clone ();
    nShredder._state = nextState;
    return nShredder;
  }

  get (path, fallbackValue) {
    this._protectShredderTools (this._pathShredder (path));
    let value;
    if (fallbackValue) {
      value = this.state.getIn (_.toPath (path), fromJS (fallbackValue));
    } else {
      value = this.state.getIn (_.toPath (path));
    }

    if (isImmutable (value)) {
      const nShredder = this._clone ();
      nShredder._state = value;
      return nShredder;
    }

    return value;
  }

  del (path) {
    this._protectShredderTools (this._pathShredder (path));
    const nextState = this.state.deleteIn (_.toPath (path));
    if (this.useLogger) {
      this.log.verb (
        `next state after del (${path}):\n${this._stateView (nextState)}`
      );
    }
    const nShredder = this._clone ();
    nShredder._state = nextState;
    return nShredder;
  }

  _stateView (state) {
    return JSON.stringify (
      state.toJS (),
      (k, v) => (k === 'parent' ? v.id : v),
      2
    );
  }
  _pathShredder (path) {
    if (!Array.isArray (path)) {
      path = _.toPath (path);
    }
    return path;
  }

  _protectShredderTools (path) {
    if (path[0] === 'set' || path[0] === 'get') {
      throw new Error (
        `Wow! You just broke your shredder ${path} tool ?!\nAre you mad?`
      );
    }
  }

  get _isSuperReaper6000 () {
    return true;
  }
}

module.exports = Shredder;
