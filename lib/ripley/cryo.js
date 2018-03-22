'use strict';

const {fromJS} = require('immutable');
const watt = require('watt');

const initialState = fromJS({});

class RipleyCryo {
  constructor(dbName, dbPath, options) {
    this._busClient = require('xcraft-core-busclient').getGlobal();

    this._table = dbName;
    this._busClient.command.send('cryo.create', {options});

    watt.wrapAll(this);
  }

  saveState(/* state */) {}

  *waitForWrites(next) {
    yield this._busClient.command.send('cryo.sync', null, null, next);
  }

  *ripley(dispatch, next) {
    this._busClient.events.subscribe(`cryo.thawed.${this._table}`, dispatch);
    yield this._busClient.command.send(
      'cryo.thaw',
      {table: this._table},
      null,
      next
    );
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

  *persist(action, rules, next) {
    const db = action && action.payload && action.payload.db;
    yield this._busClient.command.send(
      'cryo.freeze',
      {db, action, rules},
      null,
      next
    );
  }

  ellen(state = initialState /* action = {} */) {
    return state;
  }
}

module.exports = RipleyCryo;
