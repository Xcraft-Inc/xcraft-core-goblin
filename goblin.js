'use strict';

const watt = require ('watt');
const {createStore, combineReducers, applyMiddleware} = require ('redux');
const Shredder = require ('./lib/shredder.js');
const Persistence = require ('./lib/persistence.js');

function isFunction (fn) {
  return typeof fn === 'function';
}

function isGenerator (fn) {
  return (
    fn &&
    isFunction (fn) &&
    fn.constructor &&
    fn.constructor.name === 'GeneratorFunction'
  );
}

const doAsyncQuest = watt (function* (quest, dispatch, goblin) {
  const questDispatcher = function (type, payload = {}, error = false) {
    const action = isFunction (type)
      ? type
      : {
          type,
          payload,
          meta: {},
          error,
        };
    dispatch (action);
  };
  const context = {
    dispatch: questDispatcher,
    goblin: goblin,
  };
  yield quest (context);
});

const questMiddleware = goblin => store => next => action => {
  return isFunction (action)
    ? doAsyncQuest (action, store.dispatch, goblin)
    : next (action);
};

class Goblin {
  constructor (goblinName, logicState, logicHandlers, persistenceConfig) {
    this._goblinName = goblinName;

    this._persistence = new Persistence ('./', this._goblinName);

    for (const k in persistenceConfig) {
      if (!('db' in persistenceConfig[k])) {
        persistenceConfig[k].db = this._goblinName;
      }
      if (!('mode' in persistenceConfig[k])) {
        throw new Error (`Bad goblin persistence config, missing for ${k}`);
      } else {
        if (!this._persistence.hasMode (persistenceConfig[k].mode)) {
          throw new Error (
            `Bad goblin persistence config, unknow mode for ${k}`
          );
        }
      }
    }

    this._persistenceConfig = persistenceConfig || {};
    const engineState = {
      lastAction: null,
    };

    const engineReducer = (state, action) => {
      if (!state) {
        return {};
      }
      if (action.type === 'STARTING_QUEST') {
        state.currentQuest = action.payload.questName;
        state.msg = action.payload.msg;
        return state;
      }
      if (action.type === 'ENDING_QUEST') {
        state.lastAction = null;
        state.currentQuest = null;
        return state;
      }

      state.lastAction = action.type;
      return state;
    };

    const logicReducer = (state, action) => {
      if (!state) {
        return {};
      }

      if (logicHandlers[action.type]) {
        if (!action.meta._ripley) {
          action.meta = this.getCurrentMessage ().data;
        }
        return logicHandlers[action.type] (state, action);
      }

      return state;
    };

    const rootReducer = combineReducers ({
      engine: engineReducer,
      ellen: this._persistence.ellen,
      logic: logicReducer,
    });

    if (logicState._isSuperReaper6000) {
      this._shredder = logicState;
    }

    const initialState = {
      engine: engineState,
      ellen: this._persistence.initialState,
      logic: logicState,
    };

    this._store = createStore (
      rootReducer,
      initialState,
      applyMiddleware (
        this._persistence.persistWith (this._persistenceConfig),
        questMiddleware (this)
      )
    );

    this._quests = {};
  }

  get goblinName () {
    return this._goblinName;
  }

  get store () {
    return this._store;
  }

  get storeListener () {
    return this._storeListener;
  }

  get quests () {
    let quests = {};
    Object.keys (this._quests).forEach (questName => {
      quests[questName] = (msg, resp) => {
        this.dispatch (this.doQuest (questName, msg, resp).bind (this));
      };
    });
    return quests;
  }

  getState () {
    return this.store.getState ().logic;
  }

  /* See https://github.com/acdlite/flux-standard-action */
  dispatch (type, payload = {}, error = false) {
    const action = isFunction (type)
      ? type
      : {
          type,
          payload,
          meta: {},
          error,
        };
    this.store.dispatch (action);
  }

  do (payload = {}, error = false) {
    this.dispatch (this.getCurrentQuest (), payload, error);
  }

  dispose (action) {
    if (this._afterEffects[action]) {
      this._afterEffects[action].dispose ();
      delete this._afterEffects[action];
    }
  }

  getLastAction () {
    return this.store.getState ().engine.lastAction;
  }

  getCurrentQuest () {
    return this.store.getState ().engine.currentQuest;
  }

  getCurrentMessage () {
    return this.store.getState ().engine.msg;
  }

  registerQuest (questName, quest) {
    if (!isGenerator (quest)) {
      this._quests[questName] = watt (function* (q, msg, next) {
        quest (q, msg);
        yield next ();
      });
      return;
    }
    this._quests[questName] = watt (quest);
  }

  doQuest (questName, msg, resp) {
    const self = this;
    return watt (function* (quest) {
      // inject response and logger in quest
      quest.resp = resp;
      quest.log = resp.log;
      quest.cmd = watt (function* (cmd, args, next) {
        if (arguments.length === 2) {
          yield resp.command.send (cmd, next);
        }
        yield resp.command.send (cmd, args, next);
      });
      quest.evt = (customed, payload) => {
        if (payload._isSuperReaper6000) {
          payload = payload.state;
        }

        resp.events.send (`${self.goblinName}.${customed}`, payload);
      };

      quest.sub = (topic, handler) =>
        resp.events.subscribe (topic, msg => handler (null, msg));
      quest.unsub = topic => resp.events.unsubscribe (topic);

      quest.loadState = watt (function* (next) {
        quest.log.verb ('Loading state...');
        if (Object.keys (this._persistenceConfig).length > 0) {
          quest.log.verb ('Replaying...');
          yield this._persistence.ripley (this._store, resp.log, next);
          quest.log.verb ('Replaying [done]');
        } else {
          quest.log.verb ('nothing to replay (empty config)');
        }
        quest.log.verb ('Loading state [done]');
      }).bind (this);

      quest.saveState = watt (function* (next) {
        quest.log.verb ('Saving state...');
        const state = this._store.getState ();
        this._persistence.saveState (state.ellen.get (this._goblinName));
        yield this._persistence.waitForWrites (next);
        quest.log.verb ('Saving state [done]');
      }).bind (this);

      quest.log.verb ('Starting quest...');
      quest.dispatch ('STARTING_QUEST', {questName, msg});

      let result = null;
      try {
        result = yield self._quests[questName] (quest, msg);
      } catch (err) {
        if (err) {
          quest.log.err (`quest [${questName}] failure: ${err}`);
          if (err.stack) {
            quest.log.err (`stack: ${err.stack}`);
          }
        }
      } finally {
        quest.log.verb ('Ending quest...');
        const currentQuest = self.getCurrentQuest ();
        resp.events.send (
          `${self.goblinName}.${currentQuest}.finished`,
          result
        );
        quest.dispatch ('ENDING_QUEST');
      }
    });
  }
}

module.exports = Goblin;
module.exports.Shredder = Shredder;
