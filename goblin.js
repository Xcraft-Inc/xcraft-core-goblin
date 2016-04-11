'use strict';
const watt = require ('watt');
const Observable  = require ('rx').Observable;
const createStore = require ('redux').createStore;
const combineReducers = require ('redux').combineReducers;
const applyMiddleware = require ('redux').applyMiddleware;

function isFunction (fn) {
  return typeof fn === 'function';
}

function isGenerator (fn) {
  return fn && isFunction (fn) && fn.constructor && fn.constructor.name === 'GeneratorFunction';
}

function *asyncQuest (quest, dispatch, goblin, next) {
  const context = {
    dispatch: dispatch,
    goblin: goblin,
    next: next
  };
  yield* quest (context);
}

const doAsyncQuest = watt (asyncQuest);

const questMiddleware = (goblin) => store => dispatch => action => {
  return isGenerator (action) ?
    doAsyncQuest (action, dispatch, goblin) : dispatch (action);
};

class Goblin {
  constructor (goblinName, logicState, logicHandlers) {
    this._goblinName = goblinName;
    const engineState = {
      lastAction: null
    };

    const engineReducer = (state, action) => {
      if (state === undefined) {
        return {};
      }
      if (action.type === 'STARTING_QUEST') {
        state.currentQuest = action.questName;
        state.msg = action.msg;
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
      if (state === undefined) {
        return {};
      }

      if (logicHandlers[action.type]) {
        state.data = this.store && this.getCurrentMessage ().data;
        return logicHandlers[action.type] (state, action);
      } else {
        return state;
      }
    };

    const rootReducer = combineReducers ({
      engine: engineReducer,
      logic: logicReducer
    });

    const initialState = {
      engine: engineState,
      logic: logicState
    };

    this._store = createStore (
      rootReducer,
      initialState,
      applyMiddleware (questMiddleware (this))
    );

    this._quests = {};
    this._lifecycleQuests = {};

    // lifecycle quests
    const self = this;
    this.registerQuest ('__start__', function * (quest) {
      quest.log.info (`${self.goblinName} started`);
      if (self._lifecycleQuests.start) {
        yield* self._lifecycleQuests.start (quest);
      } else {
        yield quest.next ();
      }
    });

    this.registerQuest ('__stop__', function * (quest) {
      quest.log.info (`${self.goblinName} stopped`);
      if (self._lifecycleQuests.stop) {
        yield* self._lifecycleQuests.stop (quest);
      } else {
        yield quest.next ();
      }
    });
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
    Object.keys (this._quests).forEach ((questName) => {
      quests[questName] = (msg, resp) => {
        this.dispatch (this.doQuest (questName, msg, resp));
      };
    });
    return quests;
  }

  getState () {
    return this.store.getState ().logic;
  }

  dispatch (action) {
    this.store.dispatch (action);
  }

  do () {
    this.store.dispatch ({
      type: this.getCurrentQuest ()
    });
  }

  onStart (quest) {
    this._lifecycleQuests.start = quest;
  }

  onStop (quest) {
    this._lifecycleQuests.stop = quest;
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
      this._quests[questName] = function * (q, msg) {
        quest (q, msg);
        yield null;
      };
    }
    this._quests[questName] = quest;
  }

  doQuest (questName, msg, resp) {
    let self = this;
    return function * (quest) {
      // inject response and logger in quest
      quest.resp = resp;
      quest.log = resp.log;
      quest.cmd = (cmd, args, next) => resp.command.send (cmd, args, next);
      quest.evt = (customed, payload) => resp.events.send (`${self.goblinName}.${customed}`, payload);
      quest.sub = (topic, handler) => resp.events.subscribe (topic, (msg) => handler (null, msg));
      quest.unsub = (topic) => resp.events.unsubscribe (topic);
      quest.log.verb ('Starting quest...');
      quest.dispatch ({type: 'STARTING_QUEST', questName: questName, msg: msg});
      let result = null;
      try {
        result = yield* self._quests[questName] (quest, msg);
      } catch (err) {
        if (err) {
          quest.log.err  (`quest [${questName}] failure: ${err}`);
          if (err.stack) {
            quest.log.err  (`stack: ${err.stack}`);
          }
        }
      } finally {
        quest.log.verb ('Ending quest...');
        const currentQuest = self.getCurrentQuest ();
        resp.events.send (`${self.goblinName}.${currentQuest}.finished`, result);
        quest.dispatch ({type: 'ENDING_QUEST'});
      }
    };
  }
}

module.exports = Goblin;
