'use strict';

const {fromJS} = require('immutable');
const watt = require('gigawatts');
const {appMasterId} = require('xcraft-core-host');

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
    this._isReplaying = true;
    this._resp.events.subscribe(`cryo.thawed.${db}`, dispatch);
    yield this._resp.command.send('cryo.thaw', {db}, null, next);
    this._isReplaying = false;
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
    // don't persist action replayed in case of ripley
    if (this._isReplaying) {
      return next();
    }
    const db = action?.payload?.db || appMasterId;
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
