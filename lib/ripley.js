'use strict';

const path = require('path');
const xLog = require('xcraft-core-log')('ripley');

function isFunction(fn) {
  return typeof fn === 'function';
}

class Ripley {
  constructor(backend, dbName, dbPath, options) {
    const Backend = require(path.join(__dirname, 'ripley', `${backend}.js`));
    this._backend = new Backend(dbName, dbPath, options);
  }

  get backend() {
    return this._backend;
  }

  async ripley(store, db, logger) {
    await this._backend.ripley(db, (entry) => {
      logger.verb(`Ripley: ${entry.action.type}`);
      store.dispatch(entry.action);
    });
  }

  persistWith(filters) {
    return (store) => (next) => (action) => {
      if (!isFunction(action) && filters[action.type]) {
        const rules = filters[action.type];
        this._backend
          .persist(action, rules)
          .then(() => store.dispatch({type: '4ELLEN', action, rules}))
          .catch((err) => xLog.err(err.stack || err.message || err));
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
