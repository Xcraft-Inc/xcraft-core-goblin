'use strict';

const {fromJS} = require('immutable');
const watt = require('gigawatts');

const initialState = fromJS({});

class RipleyCryo {
  constructor(dbName, dbPath, options) {
    const busClient = require('xcraft-core-busclient').getGlobal();
    this._resp = busClient.newResponse('ripley-cryo', 'token');
    this._options = options;

    watt.wrapAll(this);
  }

  saveState(/* state */) {}

  *waitForWrites(next) {
    yield this._resp.command.send('cryo.sync', null, null, next);
  }

  *ripley(db, dispatch, next) {
    this._resp.events.subscribe(`cryo.thawed.${db}`, dispatch);
    yield this._resp.command.send('cryo.thaw', {db}, null, next);
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
    yield this._resp.command.send(
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
