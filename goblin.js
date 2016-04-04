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

function *asyncQuest (quest, dispatch, goblin, store, next) {
  const context = {
    dispatch: dispatch,
    goblin: goblin,
    store: store,
    next: next
  };
  yield* quest (context);
}

const doAsyncQuest = watt (asyncQuest);

const questMiddleware = (goblin) => store => dispatch => action => {
  return isGenerator (action) ?
    doAsyncQuest (action, dispatch, goblin, store) : dispatch (action);
};

class Goblin {
  constructor (goblinName, logicState, logicHandlers) {
    this._busClient = require ('xcraft-core-busclient').getGlobal ();
    this._goblinName = goblinName;
    this._logger = require ('xcraft-core-log') ('goblin::' + goblinName);
    const engineState = {
      lastAction: null
    };

    const engineReducer = (state, action) => {
      if (state === undefined) {
        return {};
      }
      if (action.type === 'STARTING_QUEST') {
        state.currentQuest = action.questName;
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
    console.log (`store initialized ${this.store.getState ()}`);
    this._listener = Observable.create (observer =>
      this._store.subscribe (() => observer.onNext (this._store.getState ()))
    );

    this._subscriptions = {};
    this._quests = {};
  }

  get goblinName () {
    return this._goblinName;
  }

  get busClient () {
    return this._busClient;
  }

  get store () {
    return this._store;
  }

  get listener () {
    return this._listener;
  }

  get subscriptions () {
    return this._subscriptions;
  }

  get logger () {
    return this._logger;
  }

  get quests () {
    let quests = {};
    Object.keys (this._quests).forEach ((questName) => {
      quests[questName] = (msg) => {
        this.dispatch (this.doQuest (questName, msg));
      };
    });
    return quests;
  }
  dispatch (action) {
    this.store.dispatch (action);
  }

  subscribe (action, handler) {
    if (this._subscriptions[action]) {
      return this._subscriptions[action];
    }
    this._subscriptions[action] = this._listener
                .filter ((state) => state.engine.lastAction === action)
                .doOnNext ( (state) => handler (state.logic)).subscribe ();
    return this._subscriptions[action];
  }

  unsubscribe (action) {
    if (this._subscriptions[action]) {
      this._subscriptions[action].dispose ();
    }
  }

  getLastAction () {
    return this.store.getState ().engine.lastAction;
  }

  send (customed, payload) {
    this.busClient.events.send (`${this.goblinName}.${customed}`, payload);
  }

  sendFinishEvent (result) {
    const lastAction = this.getLastAction ();
    this.busClient.events.send (`${this.goblinName}.${lastAction}.finished`, result);
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

  doQuest (questName, msg) {
    let self = this;
    return function * (quest) {
      self.logger.verb ('Starting quest...');
      quest.dispatch ({type: 'STARTING_QUEST'});
      let result = null;
      try {
        result = yield* self._quests[questName] (quest, msg);
      } catch (err) {
        if (err) {
          self.logger.err  (`quest [${questName}] failure: ${err}`);
          if (err.stack) {
            self.logger.err  (`stack: ${err.stack}`);
          }
        }
      } finally {
        self.logger.verb ('Ending quest...');
        self.sendFinishEvent (result);
        quest.dispatch ({type: 'ENDING_QUEST'});
      }
    };
  }
}

module.exports = Goblin;
