'use strict';

const {fromJS} = require('immutable');
const {appMasterId} = require('xcraft-core-host');

const initialState = fromJS({});

class RipleyCryo {
  constructor(dbName, dbPath, options) {
    const busClient = require('xcraft-core-busclient').getGlobal();
    this._resp = busClient.newResponse('ripley-cryo', 'token');
    this._options = options;
  }

  async ripley(db, dispatch) {
    this._isReplaying = true;
    this._resp.events.subscribe(`cryo.thawed.${db}`, dispatch);
    await this._resp.command.sendAsync('cryo.thaw', {db});
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

  async _persist(action, rules) {
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
      /* Copy the action because this middleware must not change
       * the original payload
       */
      action = {...action, ...{payload: {}}};
    }

    const data = await this._resp.command.sendAsync('cryo.freeze', {
      db,
      action,
      rules,
      raw,
    });
    if (isPersist && data) {
      this.lastPersistedAction = data.action;
    }
  }

  async persist(action, rules) {
    // don't persist action replayed in case of ripley
    if (this._isReplaying) {
      return;
    }

    const commitId = action.get('commitId');
    try {
      await this._persist(action, rules);
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
