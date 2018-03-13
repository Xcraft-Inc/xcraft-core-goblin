'use strict';

const _ = require('highland');
const lodash = require('lodash');
const {fromJS} = require('immutable');
const watt = require('watt');
const path = require('path');
const mkdirp = require('mkdirp').sync;
const StateDb = require('statedb');
const traverse = require('traverse');
const fs = require('fs-extra');

const initialState = fromJS({
  counter: 0,
  version: '1.0',
});

class RipleyStateDb {
  constructor(appDataPath, dbName, dbPath, options) {
    mkdirp(appDataPath);

    const _dbOrig = path.join(appDataPath, dbName);
    const _dbPath = dbPath || _dbOrig;

    if (
      dbPath &&
      options &&
      options.syncCopy &&
      !fs.existsSync(`${dbPath}.db`)
    ) {
      fs.copySync(`${_dbOrig}.db`, `${dbPath}.db`);
    }

    this._db = new StateDb(_dbPath, null, {async: true});

    watt.wrapAll(this);
  }

  saveState(state) {
    this._db.saveState('ripley', state);
  }

  *waitForWrites(next) {
    yield this._db.waitForWrites(next.arg(0));
  }

  ripley(dispatch, next) {
    const ripley = _.values(this._db.loadState('ripley'));
    ripley.toArray(actions => {
      _(
        traverse(actions).reduce((acc, node) => {
          if (node && node.hasOwnProperty('@@COMMAND_ORDER')) {
            acc.push(node);
          }
          return acc;
        }, [])
      )
        .sortBy((actionA, actionB) => {
          return actionA['@@COMMAND_ORDER'] - actionB['@@COMMAND_ORDER'];
        })
        .each(dispatch)
        .done(() => {
          next();
        });
    });
  }

  hasMode(mode) {
    const knowModes = {
      allbykeys: true,
      all: true,
      last: true,
    };
    return !!knowModes[mode];
  }

  get initialState() {
    return initialState;
  }

  persist(/*action, rules */) {}

  ellen(state = initialState, action = {}) {
    const rules = action.rules;
    const counter = state.get('counter') + 1;
    const newState = state.set('counter', counter);
    let entry = null;

    switch (rules.mode) {
      case 'allbykeys': {
        if (
          !rules.db ||
          !rules.mode ||
          rules.keys.some(k => !lodash.at(action.action, k))
        ) {
          return state;
        }

        entry = newState.getIn([rules.db, rules.mode, action.action.type], {});
        let key = '';
        rules.keys.forEach(prop => {
          key += `&&${lodash.at(action.action, prop)}`;
        });
        entry[key] = {'@@COMMAND_ORDER': counter, action: action.action};
        break;
      }

      case 'all': {
        if (!rules.db || !rules.mode) {
          return state;
        }

        entry = newState.getIn([rules.db, rules.mode, action.action.type], []);
        entry.push({'@@COMMAND_ORDER': counter, action: action.action});
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

    return newState.setIn([rules.db, rules.mode, action.action.type], entry);
  }
}

module.exports = RipleyStateDb;
