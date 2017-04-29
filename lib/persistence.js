'use strict';

const _ = require ('highland');
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

    watt.wrapAll (this);
  }

  get db () {
    return this._db;
  }

  *waitForWrites (next) {
    yield this._db.waitForWrites (next.arg (0));
  }

  ripley (store, logger, done) {
    const ripley = _.values (this._db.loadState ('ripley'));

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
          store.dispatch (action.action);
        })
        .done (done);
    });
  }

  persistWith (filters) {
    return store => next => action => {
      if (isFunction (action)) {
        return action (store.dispatch, store.getState ());
      }
      if (filters[action.type]) {
        const rules = filters[action.type];
        store.dispatch ({type: '4ELLEN', action: action, rules: rules});
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
          rules.keys.some (k => !action.action[k])
        ) {
          return state;
        }

        entry = newState.getIn ([rules.db, rules.mode, action.action.type], {});
        let key = '';
        rules.keys.forEach (prop => {
          key += `&&${action.action[prop]}`;
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
