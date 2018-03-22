'use strict';

const watt = require('watt');
const path = require('path');

function isFunction(fn) {
  return typeof fn === 'function';
}

class Ripley {
  constructor(backend, appDataPath, dbName, dbPath, options) {
    const Backend = require(path.join(__dirname, 'ripley', `${backend}.js`));
    this._backend = new Backend(appDataPath, dbName, dbPath, options);

    watt.wrapAll(this);
  }

  saveState(state) {
    this._backend.saveState(state);
  }

  *waitForWrites() {
    yield this._backend.waitForWrites();
  }

  *ripley(store, logger, next) {
    this._isReplaying = true;
    yield this._backend.ripley(entry => {
      logger.verb(`Ripley: ${entry.action.type}`);
      store.dispatch(entry.action);
    }, next);
    this._isReplaying = false;
  }

  persistWith(filters) {
    return store => next => action => {
      if (this._isReplaying) {
        return next(action);
      }
      if (!isFunction(action) && filters[action.type]) {
        const rules = filters[action.type];
        this._backend.persist(action, rules, err => {
          if (err) {
            console.error(err.stack || err);
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
