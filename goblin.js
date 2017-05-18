'use strict';

const watt = require ('watt');
const {createStore, combineReducers, applyMiddleware} = require ('redux');
const Shredder = require ('xcraft-core-shredder');
const Persistence = require ('./lib/persistence.js');
const uuidV4 = require ('uuid/v4');

function createAction (type, payload, meta, error) {
  const action = isFunction (type)
    ? type
    : {
        type,
        payload,
        meta: payload.meta || {},
        error,
      };

  if (!isFunction (type)) {
    action.get = key =>
      action.payload[key] ? action.payload[key] : action.meta[key];
  }
  return action;
}

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
    const action = createAction (type, payload, error);
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

function injectMessageDataGetter (msg) {
  msg.get = key => {
    if (msg.data) {
      return msg.data[key];
    }
    return null;
  };
}

// Quest registry
const QUESTS = {};

// Goblins registry
const GOBLINS = {};

// Configs registry
const CONFIGS = {};

class Goblin {
  static registerQuest (goblinName, questName, quest) {
    if (!QUESTS[goblinName]) {
      QUESTS[goblinName] = {};
    }
    if (!isGenerator (quest)) {
      QUESTS[goblinName][questName] = watt (function* (q, msg, next) {
        return quest (q, msg);
        //yield next (null, res);
      });
      return;
    }
    QUESTS[goblinName][questName] = watt (quest);
  }

  static getQuests (goblinName) {
    let quests = {};
    Object.keys (QUESTS[goblinName]).forEach (questName => {
      //Handle create
      if (questName === 'create') {
        quests[questName] = (msg, resp) => {
          injectMessageDataGetter (msg);
          const id = msg.get ('id') || uuidV4 ();
          const fullId = `${goblinName}@${id}`;
          const goblin = Goblin.create (goblinName, fullId);
          goblin.dispatch (goblin.doQuest (questName, msg, resp).bind (goblin));
        };
        return;
      }

      quests[questName] = (msg, resp) => {
        if (!GOBLINS[goblinName]) {
          resp.log.err (
            `You must call ${goblinName}.create before calling ${questName}`
          );
          resp.events.send (`${goblinName}.${questName}.finished`, null);
          return;
        }

        // Single?
        if (GOBLINS[goblinName][goblinName]) {
          const goblin = GOBLINS[goblinName][goblinName];
          goblin.dispatch (goblin.doQuest (questName, msg, resp).bind (goblin));
          return;
        }

        if (!msg.data) {
          resp.log.err (`No id provided for ${goblinName}`);
          resp.events.send (`${goblinName}.${questName}.finished`, null);
          return;
        }
        if (!msg.data.id) {
          resp.log.err (`No id provided for ${goblinName}`);
          resp.events.send (`${goblinName}.${questName}.finished`, null);
          return;
        }
        const goblin = GOBLINS[goblinName][msg.data.id];
        if (!goblin) {
          resp.log.err (`Bad id ${msg.data.id} for ${goblinName}`);
          resp.events.send (`${goblinName}.${questName}.finished`, null);
          return;
        }
        goblin.dispatch (goblin.doQuest (questName, msg, resp).bind (goblin));
      };
    });
    return quests;
  }

  static configure (goblinName, logicState, logicHandlers, persistenceConfig) {
    if (!CONFIGS[goblinName]) {
      CONFIGS[goblinName] = {};
    }
    CONFIGS[goblinName] = {
      logicState,
      logicHandlers,
      persistenceConfig,
    };

    if (!GOBLINS[goblinName]) {
      GOBLINS[goblinName] = {};
    }

    return Goblin.getQuests (goblinName);
  }

  static create (goblinName, uniqueIdentifier) {
    if (!GOBLINS[goblinName]) {
      GOBLINS[goblinName] = {};
    }
    // Single ?
    if (GOBLINS[goblinName][goblinName]) {
      throw new Error ('A single goblin exist');
    }
    const goblinId = uniqueIdentifier || uuidV4 ();
    GOBLINS[goblinName][goblinId] = new Goblin (
      goblinId,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].persistenceConfig
    );

    return GOBLINS[goblinName][goblinId];
  }

  static createSingle (goblinName) {
    if (!GOBLINS[goblinName]) {
      GOBLINS[goblinName] = {};
    }
    GOBLINS[goblinName][goblinName] = new Goblin (
      goblinName,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].persistenceConfig
    );

    return GOBLINS[goblinName][goblinName];
  }

  constructor (
    goblinId,
    goblinName,
    logicState,
    logicHandlers,
    persistenceConfig
  ) {
    const path = require ('path');
    const xConfig = require ('xcraft-core-etc') ().load ('xcraft');

    this._goblinId = goblinId;
    this._goblinName = goblinName;
    this._logger = require ('xcraft-core-log') (goblinName, null);
    this._persistence = new Persistence (
      path.join (xConfig.xcraftRoot, 'var/ripley'),
      this._goblinName
    );

    for (const k in persistenceConfig) {
      if (!('db' in persistenceConfig[k])) {
        persistenceConfig[k].db = `${this._goblinName}-${this._goblinId}`;
      }
      if (!('mode' in persistenceConfig[k])) {
        throw new Error (`Bad goblin persistence config, missing for ${k}`);
      }
      if (!this._persistence.hasMode (persistenceConfig[k].mode)) {
        throw new Error (`Bad goblin persistence config, unknow mode for ${k}`);
      }
    }

    this._persistenceConfig = persistenceConfig || {};
    const engineState = {};

    const engineReducer = (state, action) => {
      if (!state) {
        return {};
      }

      if (action.type === 'STARTING_QUEST') {
        return state;
      }
      if (action.type === 'ENDING_QUEST') {
        return state;
      }

      return state;
    };

    const logicReducer = (state, action) => {
      if (!state) {
        return {};
      }

      if (logicHandlers[action.type]) {
        return logicHandlers[action.type] (state, action);
      }

      return state;
    };

    this._logicHasType = type => {
      return !!logicHandlers[type];
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

    if (this.usePersistence) {
      this._unsubscribePersistence = this._store.subscribe (() => {
        this._logger.verb ('Saving state...');
        const state = this._store.getState ();
        this._persistence.saveState (state.ellen.get (this._goblinName));
      });
    }
  }

  get id () {
    return this._goblinId;
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

  get usePersistence () {
    return Object.keys (this._persistenceConfig).length > 0;
  }

  getState () {
    return this.store.getState ().logic;
  }

  /* See https://github.com/acdlite/flux-standard-action */
  dispatch (type, payload = {}, error = false) {
    const action = createAction (type, payload, error);
    this.store.dispatch (action);
  }

  _do (questName, payload = {}, error = false) {
    if (!this._logicHasType (questName)) {
      throw new Error (`Cannot do (${questName}), missing logic handler`);
    }
    this.dispatch (questName, payload, error);
  }

  dispose (action) {
    if (this._afterEffects[action]) {
      this._afterEffects[action].dispose ();
      delete this._afterEffects[action];
    }
  }

  injectQuestBusHelpers (quest, resp) {
    quest.resp = resp;
    quest.log = resp.log;
    quest.cmd = watt (function* (cmd, args, next) {
      if (arguments.length === 2) {
        next = args;
        args = null;
      }
      const msg = yield resp.command.send (cmd, args, next);
      return msg.data;
    });
    quest.evt = (customed, payload) => {
      if (!payload) {
        payload = {};
      }
      if (payload._isSuperReaper6000) {
        payload = payload.state;
      }

      resp.events.send (`${this.goblinName}.${customed}`, payload);
    };

    quest.sub = function (topic, handler) {
      return resp.events.subscribe (topic, msg => handler (null, msg));
    };

    quest.sub.wait = watt (function* (topic, next) {
      const _next = next.parallel ();
      const unsubWait = resp.events.subscribe (topic, msg => _next (null, msg));
      yield next.sync ();
      unsubWait ();
    });
  }

  doQuest (questName, msg, resp) {
    const self = this;
    return watt (function* (quest) {
      injectMessageDataGetter (msg);
      this.injectQuestBusHelpers (quest, resp);

      quest.loadState = watt (function* (next) {
        quest.log.verb ('Loading state...');
        if (this.usePersistence) {
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

      quest.do = (action = {}, ...args) => {
        action.meta = msg.data;
        return this._do (questName, action, msg.data, ...args);
      };

      quest.log.verb ('Starting quest...');
      quest.dispatch ('STARTING_QUEST', {questName, msg});

      let result = null;
      try {
        if (this._shredder) {
          this._shredder.attachLogger (resp.log);
        }
        result = yield QUESTS[this._goblinName][questName] (quest, msg);
        if (self.goblinName !== 'warehouse') {
          quest.log.verb (`${self.goblinName} upserting`);

          yield quest.cmd ('warehouse.upsert', {
            branch: self._goblinId,
            data: this._shredder ? self.getState ().state : self.getState (),
          });
        }
      } catch (err) {
        if (err) {
          quest.log.err (`quest [${questName}] failure: ${err}`);
          if (err.stack) {
            quest.log.err (`stack: ${err.stack}`);
          }
        }
      } finally {
        quest.log.verb ('Ending quest...');
        resp.events.send (`${this.goblinName}.${questName}.finished`, result);
        quest.dispatch ('ENDING_QUEST');
        if (this._shredder) {
          this._shredder.detachLogger ();
        }
      }
    });
  }
}

module.exports = Goblin;
module.exports.Shredder = Shredder;
