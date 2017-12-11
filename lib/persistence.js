'use strict';

const _ = require ('highland');
const lodash = require ('lodash');
const {fromJS} = require ('immutable');
const watt = require ('watt');
const path = require ('path');
const mkdirp = require ('mkdirp').sync;
const StateDb = require ('statedb');
const traverse = require ('traverse');
const fs = require ('fs-extra');
const initialState = fromJS ({
  counter: 0,
  version: '1.0',
});
function isFunction (fn) {
  return typeof fn === 'function';
}

class Persistence {
  constructor (appDataPath, dbName, dbPath, options) {
    mkdirp (appDataPath);

    const _dbOrig = path.join (appDataPath, dbName);

    const _dbPath = dbPath || _dbOrig;

    if (
      dbPath &&
      options &&
      options.syncCopy &&
      !fs.existsSync (`${dbPath}.db`)
    ) {
      fs.copySync (`${_dbOrig}.db`, `${dbPath}.db`);
    }

    this._db = new StateDb (_dbPath, null, {async: true});
    this._isReplaying = false;
    watt.wrapAll (this);
  }

  get db () {
    return this._db;
  }

  saveState (state) {
    this._db.saveState ('ripley', state);
  }

  *waitForWrites (next) {
    yield this._db.waitForWrites (next.arg (0));
  }

  ripley (store, logger, next) {
    const ripley = _.values (this._db.loadState ('ripley'));
    this._isReplaying = true;
    ripley.toArray (actions => {
      _ (
        traverse (actions).reduce ((acc, node) => {
          if (node && node.hasOwnProperty ('@@COMMAND_ORDER')) {
            acc.push (node);
          }
          return acc;
        }, [])
      )
        .sortBy ((actionA, actionB) => {
          return actionA['@@COMMAND_ORDER'] - actionB['@@COMMAND_ORDER'];
        })
        .each (action => {
          logger.verb (`RipleY: ${action.action.type}`);
          action.action.meta._ripley = true;
          store.dispatch (action.action);
        })
        .done (() => {
          this._isReplaying = false;
          next ();
        });
    });
  }

  persistWith (filters) {
    return store => next => action => {
      if (this._isReplaying) {
        return next (action);
      }
      if (!isFunction (action)) {
        if (filters[action.type]) {
          const rules = filters[action.type];
          store.dispatch ({type: '4ELLEN', action: action, rules: rules});
        }
      }
      // continue
      return next (action);
    };
  }

  hasMode (mode) {
    const knowModes = {
      allbykeys: true,
      all: true,
      last: true,
    };
    return knowModes[mode] !== undefined;
  }

  get initialState () {
    return initialState;
  }

  ellen (state = initialState, action = {}) {
    if (action.type !== '4ELLEN') {
      return state;
    }

    const rules = action.rules;
    const counter = state.get ('counter') + 1;
    const newState = state.set ('counter', counter);
    let entry = null;

    switch (rules.mode) {
      case 'allbykeys': {
        if (
          !rules.db ||
          !rules.mode ||
          rules.keys.some (k => !lodash.at (action.action, k))
        ) {
          return state;
        }

        entry = newState.getIn ([rules.db, rules.mode, action.action.type], {});
        let key = '';
        rules.keys.forEach (prop => {
          key += `&&${lodash.at (action.action, prop)}`;
        });
        entry[key] = {'@@COMMAND_ORDER': counter, action: action.action};
        break;
      }

      case 'all': {
        if (!rules.db || !rules.mode) {
          return state;
        }

        entry = newState.getIn ([rules.db, rules.mode, action.action.type], []);
        entry.push ({'@@COMMAND_ORDER': counter, action: action.action});
        break;
      }

      case 'last': {
        entry = {
          '@@COMMAND_ORDER': counter,
          action: action.action,
        };
        break;
      }
    }

    return newState.setIn ([rules.db, rules.mode, action.action.type], entry);
  }
}

module.exports = Persistence;
