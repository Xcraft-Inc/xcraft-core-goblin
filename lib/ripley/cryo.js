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

  *_persist(action, rules, next) {
    const isPersist = action.type === 'persist';
    const db = action?.payload?.db || rules.db || appMasterId;

    /* Here we support a complete persist action (not just the state).
     * It's used in the case of the synchronisation when a persist
     * action comes from the server and must be set as-it in the client
     * cryo actions store.
     */
    let raw = false;
    if (isPersist && action.meta.action) {
      raw = true;
      action.payload = {};
    }

    const {data} = yield this._resp.command.send(
      'cryo.freeze',
      {db, action, rules, raw},
      next
    );
    if (isPersist && data) {
      this.lastPersistedAction = data.action;
    }
  }

  *persist(action, rules) {
    // don't persist action replayed in case of ripley
    if (this._isReplaying) {
      return;
    }

    const commitId = action.get('commitId');
    try {
      yield this._persist(action, rules);
      if (commitId) {
        this._resp.events.send(`<${rules.goblin}-${commitId}-freezed>`);
      }
    } catch (ex) {
      if (commitId) {
        this._resp.events.send(
          `<${rules.goblin}-${commitId}-freezed>`,
          ex.stack || ex.message || ex
        );
      }
      throw ex;
    }
  }

  ellen(state = initialState /* action = {} */) {
    return state;
  }
}

module.exports = RipleyCryo;
