'use strict';

const watt = require('gigawatts');
const path = require('path');
const xLog = require('xcraft-core-log')('ripley');

function isFunction(fn) {
  return typeof fn === 'function';
}

class Ripley {
  constructor(backend, dbName, dbPath, options) {
    const Backend = require(path.join(__dirname, 'ripley', `${backend}.js`));
    this._backend = new Backend(dbName, dbPath, options);

    watt.wrapAll(this);
  }

  get backend() {
    return this._backend;
  }

  saveState(state) {
    this._backend.saveState(state);
  }

  *ripley(store, db, logger, next) {
    yield this._backend.ripley(
      db,
      (entry) => {
        logger.verb(`Ripley: ${entry.action.type}`);
        store.dispatch(entry.action);
      },
      next
    );
  }

  persistWith(filters) {
    return (store) => (next) => (action) => {
      if (!isFunction(action) && filters[action.type]) {
        const rules = filters[action.type];
        this._backend.persist(action, rules, (err) => {
          if (err) {
            xLog.err(err.stack || err.message || err);
            return;
          }
          store.dispatch({type: '4ELLEN', action, rules});
        });
      }
      return next(action);
    };
  }

  hasMode(mode) {
    return this._backend.hasMode(mode);
  }

  get initialState() {
    return this._backend.initialState;
  }

  ellen(state = {}, action = {}) {
    return action.type === '4ELLEN'
      ? this._backend.ellen(state, action)
      : state;
  }
}

module.exports = Ripley;
