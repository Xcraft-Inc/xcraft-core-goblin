'use strict';

const watt = require ('watt');
const {Observable} = require ('rx'); // FIXME: use it!
const {createStore, combineReducers, applyMiddleware} = require ('redux');
const Shredder = require ('./lib/shredder.js');
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

const questMiddleware = goblin => store => dispatch => action => {
  return isFunction (action)
    ? doAsyncQuest (action, dispatch, goblin)
    : dispatch (action);
};

class Goblin {
  constructor (goblinName, logicState, logicHandlers) {
    this._goblinName = goblinName;
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
        action.meta = this.store && this.getCurrentMessage ().data;
        return logicHandlers[action.type] (state, action);
      }

      return state;
    };

    const rootReducer = combineReducers ({
      engine: engineReducer,
      logic: logicReducer,
    });

    if (logicState._isSuperReaper6000) {
      console.log ('SuperReaper6000 detected!');
      this._shredder = logicState;
    }

    const initialState = {
      engine: engineState,
      logic: logicState,
    };

    this._store = createStore (
      rootReducer,
      initialState,
      applyMiddleware (questMiddleware (this))
    );

    this._quests = {};
  }

  static Shredder () {
    return Shredder;
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
      if (this._shredder) {
        this._shredder.attachLogger (resp.log);
      }
      quest.cmd = watt (function* (cmd, args, next) {
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
