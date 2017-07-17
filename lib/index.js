'use strict';

const watt = require ('watt');
const {createStore, combineReducers, applyMiddleware} = require ('redux');
const Shredder = require ('xcraft-core-shredder');
const Persistence = require ('./persistence.js');
const uuidV4 = require ('uuid/v4');

function jsifyQuestName (quest) {
  return quest.replace (/-([a-z])/g, (m, g1) => g1.toUpperCase ());
}

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

function getContextManager () {
  return {
    get: name => {
      const states = {};
      const ids = [];
      let single = false;
      Object.keys (GOBLINS[name]).forEach (k => {
        if (k === name) {
          single = true;
        }
        ids.push (k);
        states[k] = GOBLINS[name][k].store.getState ();
      });
      //TODO: Call delete
      return {
        states,
        ids,
        isSingle: single && GOBLINS[name].size === 1,
        sessions: SESSIONS[name] || {},
      };
    },
    set: watt (function* (name, context, resp, next) {
      for (const id of context.ids) {
        yield resp.command.send (`${name}.create`, {id}, next);
        SESSIONS[name][id] = context.sessions[id];
        const goblin = GOBLINS[name][id];
        const state = context.states[id];
        goblin.store.dispatch ({
          type: '@@RELOAD_STATE',
          state: state.logic,
        });

        if (name !== 'warehouse') {
          const data = goblin.getState ().state;
          resp.command.send ('warehouse.upsert', {
            branch: id,
            data: data,
          });
        }
      }
    }),
  };
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
let QUESTS = {};

// Quests metadata for handlers
const QUESTSMETA = {};

// Goblins registry
let GOBLINS = {};

// Goblins owned usable services
let GOBLINS_USES = {};

let GOBLINS_DEPS = {};

// Goblins sessions
let SESSIONS = {};

// Configs registry
let CONFIGS = {};

class Goblin {
  static getCommands () {
    return {
      status: (msg, resp) => {
        const status = {};
        Object.keys (GOBLINS).forEach (name => {
          status[name] = Object.keys (GOBLINS[name]);
          resp.log.info (`${name}: ${status[name].join (', ')}`);
        });
        resp.events.send ('goblin.status', status);
        resp.events.send (`goblin.status.${msg.id}.finished`);
      },
    };
  }
  static registerQuest (goblinName, questName, quest) {
    if (!QUESTSMETA[goblinName]) {
      QUESTSMETA[goblinName] = {};
    }

    const xUtils = require ('xcraft-core-utils');
    if (!QUESTSMETA[goblinName][questName]) {
      QUESTSMETA[goblinName][questName] = {};
    }
    QUESTSMETA[goblinName][questName].params = xUtils.reflect
      .funcParams (quest)
      .filter (param => !/^(quest|next)$/.test (param));

    /* Extract the parameters available in the msg [m] object and spreads
     * to the real command handler.
     * The first parameter is always the quest and the last can be the callback
     * function (`next` according to watt).
     */
    const _quest = (q, m, n) => {
      const args = QUESTSMETA[goblinName][questName].params.map (m.get);

      args.unshift (q);
      if (n) {
        args.push (n);
      }

      return quest (...args);
    };

    if (!QUESTS[goblinName]) {
      QUESTS[goblinName] = {};
    }
    if (!isGenerator (quest)) {
      QUESTS[goblinName][questName] = watt (function* (q, msg) {
        return _quest (q, msg);
      });
      return;
    }
    QUESTS[goblinName][questName] = watt (_quest);
  }

  static getQuests (goblinName) {
    const quests = {};

    Object.keys (QUESTS[goblinName]).forEach (questName => {
      //Handle create
      if (questName === 'create') {
        quests[questName] = (msg, resp) => {
          injectMessageDataGetter (msg);
          const id = msg.get ('id') || `${goblinName}@${uuidV4 ()}`;
          if (id.indexOf ('@') === -1) {
            throw new Error (
              `Bad gobelin id provided during ${goblinName}.create, id must respect this format:
              (meta@)name@unique-identifier`
            );
          }
          const goblin = Goblin.create (goblinName, id);
          goblin.dispatch (goblin.doQuest (questName, msg, resp).bind (goblin));
        };
        return;
      }

      quests[questName] = (msg, resp) => {
        if (!GOBLINS[goblinName]) {
          resp.log.err (
            `You must call ${goblinName}.create before calling ${questName}`
          );
          resp.events.send (
            `${goblinName}.${questName}.${msg.id}.finished`,
            null
          );
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
          resp.events.send (
            `${goblinName}.${questName}.${msg.id}.finished`,
            null
          );
          return;
        }
        if (!msg.data.id) {
          resp.log.err (`No id provided for ${goblinName}`);
          resp.events.send (
            `${goblinName}.${questName}.${msg.id}.finished`,
            null
          );
          return;
        }
        const goblin = GOBLINS[goblinName][msg.data.id];
        if (!goblin) {
          resp.log.err (`Bad id ${msg.data.id} for ${goblinName}`);
          resp.events.send (
            `${goblinName}.${questName}.${msg.id}.finished`,
            null
          );
          return;
        }
        goblin.dispatch (goblin.doQuest (questName, msg, resp).bind (goblin));

        //Handle delete
        if (questName === 'delete') {
          delete GOBLINS[goblinName][msg.data.id];
          for (const g in GOBLINS_USES[goblinName][msg.data.id]) {
            const use = GOBLINS_USES[goblinName][msg.data.id][g];
            resp.command.send (`${use.namespace}.delete`, {id: use.id});
          }
          delete GOBLINS_USES[goblinName][msg.data.id];
          return;
        }
      };
    });

    return quests;
  }

  static isDepOf (whichGoblinId, whereGoblinId) {
    if (whichGoblinId === whereGoblinId) {
      return true; //To be or not to be, def of itself ?!
    }
    return GOBLINS_DEPS[whereGoblinId].indexOf (whichGoblinId) !== -1;
  }

  static getRC (goblinName) {
    const rc = {};

    Object.keys (QUESTS[goblinName]).forEach (questName => {
      const params = {};
      const desc = !questName.startsWith ('_')
        ? `${questName} for ${goblinName}`
        : null;

      const list = QUESTSMETA[goblinName][questName].params;
      params.required = list;

      rc[questName] = {
        parallel: true,
        desc,
        options: {
          params,
        },
      };
    });

    return rc;
  }

  static getDeps (goblinId) {
    return GOBLINS_DEPS[goblinId];
  }

  static configure (goblinName, logicState, logicHandlers, persistenceConfig) {
    if (!CONFIGS[goblinName]) {
      CONFIGS[goblinName] = {};
    }

    if (!SESSIONS[goblinName]) {
      SESSIONS[goblinName] = {};
    }

    CONFIGS[goblinName] = {
      logicState,
      logicHandlers,
      persistenceConfig,
    };

    if (!GOBLINS[goblinName]) {
      GOBLINS[goblinName] = {};
      GOBLINS_USES[goblinName] = {};
    }

    return {
      handlers: Goblin.getQuests (goblinName),
      context: getContextManager (),
      rc: Goblin.getRC (goblinName),
    };
  }

  static create (goblinName, uniqueIdentifier) {
    if (!GOBLINS[goblinName]) {
      GOBLINS[goblinName] = {};
      GOBLINS_USES[goblinName] = {};
    }
    // Single ?
    if (GOBLINS[goblinName][goblinName]) {
      throw new Error ('A single goblin exist');
    }
    const goblinId = uniqueIdentifier || `${goblinName}@${uuidV4 ()}`;
    GOBLINS[goblinName][goblinId] = new Goblin (
      goblinId,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].persistenceConfig
    );
    GOBLINS_USES[goblinName][goblinId] = {};
    return GOBLINS[goblinName][goblinId];
  }

  static createSingle (goblinName) {
    if (!GOBLINS[goblinName]) {
      GOBLINS[goblinName] = {};
      GOBLINS_USES[goblinName] = {};
    }

    if (GOBLINS[goblinName][goblinName]) {
      throw new Error ('A single goblin exist');
    }

    GOBLINS[goblinName][goblinName] = new Goblin (
      goblinName,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].persistenceConfig
    );
    GOBLINS_USES[goblinName][goblinName] = {};
    return GOBLINS[goblinName][goblinName];
  }

  _do (questName, payload = {}, error = false) {
    if (!this._logicHasType (questName)) {
      throw new Error (`Cannot do (${questName}), missing logic handler`);
    }
    this.dispatch (questName, payload, error);
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
    this._deferrable = [];
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

      if (action.type === '@@RELOAD_STATE') {
        return action.state;
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

    const initialState = {
      engine: engineState,
      ellen: this._persistence.initialState,
      logic: new Goblin.Shredder (logicState),
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
        this._logger.verb (`Saving ${this._goblinName} state...`);
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

  setX (key, value) {
    if (value && value._dontKeepRefOnMe) {
      throw new Error (`You cannot setX with ${key} value`);
    }
    if (!SESSIONS[this.goblinName][this.id]) {
      SESSIONS[this.goblinName][this.id] = {};
    }
    SESSIONS[this.goblinName][this.id][key] = value;
  }

  getX (key) {
    if (!SESSIONS[this.goblinName][this.id]) {
      return null;
    }
    return SESSIONS[this.goblinName][this.id][key];
  }

  delX (key) {
    delete SESSIONS[this.goblinName][this.id][key];
  }

  getState () {
    return this.store.getState ().logic;
  }

  /* See https://github.com/acdlite/flux-standard-action */
  dispatch (type, payload = {}, error = false) {
    const action = createAction (type, payload, error);
    this.store.dispatch (action);
  }

  defer (action) {
    this._deferrable.push (action);
  }

  injectQuestBusHelpers (quest, resp) {
    quest._deferrable = [];
    quest.defer = func => quest._deferrable.push (func);
    quest.resp = resp;
    quest.log = resp.log;

    quest.cmdWithSideFX = watt (function* (sideFX, cmd, args, next) {
      const msg = yield resp.command.send (cmd, args, (...args) => {
        sideFX (...args);
        next (...args);
      });
      return msg.data;
    });

    quest.cmd = watt (function* (cmd, args, next) {
      if (arguments.length === 2) {
        next = args;
        args = null;
      }
      const msg = yield resp.command.send (cmd, args, next);
      return msg.data;
    });

    quest.canUse = useKey => {
      return GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id][useKey];
    };

    quest.useAs = function (namespace, id) {
      //Inject goblins API
      const api = {
        id,
        _dontKeepRefOnMe: true,
      };
      const goblin = /^[a-z\-]+/.exec (namespace)[0];
      Object.keys (QUESTS[goblin])
        .filter (
          // Exclude create and _private calls and take only namespace calls
          questName =>
            `${goblin}.${questName}`.startsWith (namespace) &&
            !questName.match (/(^create$|^.+\.create$|^_.+|\._.+)/)
        )
        .map (questName => {
          return {
            call: jsifyQuestName (questName.replace (/^[a-z\-]+\./, '')),
            questName,
          };
        })
        .forEach (
          item =>
            (api[item.call] = payload => {
              return quest.cmd (
                `${goblin}.${item.questName}`,
                Object.assign (
                  {
                    id,
                  },
                  payload
                )
              );
            })
        );
      return api;
    };

    quest.use = function (useKey) {
      if (!useKey) {
        throw new Error (`Undefined useKey`);
      }

      if (!GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id][useKey]) {
        throw new Error (
          `Cannot use ${useKey} goblin in ${quest.goblin.goblinName}, usable goblins are:
          ${JSON.stringify (GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id])}`
        );
      }

      const {id, namespace} = GOBLINS_USES[quest.goblin.goblinName][
        quest.goblin.id
      ][useKey];

      return quest.useAs (namespace, id);
    };

    quest.createFor = watt (function* (goblinName, goblinId, namespace, args) {
      let useRef = null;
      let useKey = namespace;
      if (namespace.indexOf ('@') !== -1) {
        namespace = namespace.split ('@')[0];
      }

      if (!GOBLINS_USES[goblinName][goblinId]) {
        throw new Error (`Unknow goblin ${goblinName} with id ${goblinId}`);
      }

      if (
        GOBLINS_USES[goblinName][goblinId] &&
        GOBLINS_USES[goblinName][goblinId][useKey]
      ) {
        throw new Error (
          `Goblin creation error in goblin ${goblinName}:
          You already created a goblin with this namespace: ${namespace}, add '@useKey' after goblin name, ex:
          const b1 = yield quest.create ('button@1', {});
          const b2 = yield quest.create ('button@2', {});
          then in another quest:
          const b1 = quest.use ('button@1');
          const b2 = quest.use ('button@2');`
        );
      }
      GOBLINS_USES[goblinName][goblinId][useKey] = {};
      useRef = GOBLINS_USES[goblinName][goblinId][useKey];
      useRef.namespace = namespace;

      const id = yield quest.cmdWithSideFX (
        (err, msg) => {
          const id = msg.data;
          GOBLINS_DEPS[id] = [];
          const deps = GOBLINS_DEPS[goblinId] || [goblinId];
          GOBLINS_DEPS[id].push (...deps, id);
          return id;
        },
        `${namespace}.create`,
        args
      );

      useRef.id = id;

      //Inject goblins API
      const api = {
        id,
        _dontKeepRefOnMe: true,
      };
      const goblin = /^[a-z\-]+/.exec (namespace)[0];
      Object.keys (QUESTS[goblin])
        .filter (
          // Exclude create and _private calls and take only namespace calls
          questName =>
            `${goblin}.${questName}`.startsWith (namespace) &&
            !questName.match (/(^create$|^.+\.create$|^_.+|\._.+)/)
        )
        .map (questName => {
          return {
            call: jsifyQuestName (questName.replace (/^[a-z\-]+\./, '')),
            questName,
          };
        })
        .forEach (
          item =>
            (api[item.call] = payload => {
              return quest.cmd (
                `${goblin}.${item.questName}`,
                Object.assign (
                  {
                    id,
                  },
                  payload
                )
              );
            })
        );
      return api;
    });

    quest.create = (namespace, args) =>
      quest.createFor (
        quest.goblin.goblinName,
        quest.goblin.id,
        namespace,
        args
      );

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
      const res = yield next.sync ();
      unsubWait ();
      if (res.length > 0) {
        return res[0].data;
      }
    });
  }

  doQuest (questName, msg, resp) {
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
        this.getState ().attachLogger (resp.log);
        result = yield QUESTS[this._goblinName][questName] (quest, msg);
        if (questName === 'create' && !result) {
          result = this._goblinId;
        }
        if (this.goblinName !== 'warehouse') {
          quest.log.verb (`${this.goblinName} upserting`);
          quest.cmd ('warehouse.upsert', {
            branch: this._goblinId,
            data: this.getState ().state,
          });
          if (questName === 'delete') {
            quest.cmd ('warehouse.remove', {
              branch: this._goblinId,
            });
          }
        }
        // FINISHED
        resp.events.send (
          `${this.goblinName}.${questName}.${msg.id}.finished`,
          result
        );
      } catch (err) {
        resp.events.send (
          `${this.goblinName}.${questName}.${msg.id}.error`,
          err
        );
        quest.log.err (`quest [${questName}] failure: ${err}`);
        if (err.stack) {
          quest.log.err (`stack: ${err.stack}`);
        }
      } finally {
        quest.log.verb ('Ending quest...');
        quest.dispatch ('ENDING_QUEST');
        this.getState ().detachLogger ();
        //QUEST DEFER SCOPED
        while (quest._deferrable.length > 0) {
          yield quest._deferrable.pop () ();
        }

        if (questName === 'create') {
          resp.events.send (`goblin.created`, {
            id: this._goblinId,
          });
        }
        if (questName === 'delete') {
          //GOBLIN DELETE QUEST DEFER SCOPED
          while (this._deferrable.length > 0) {
            yield this._deferrable.pop () ();
          }
          resp.events.send (`goblin.deleted`, {
            id: this._goblinId,
            deps: GOBLINS_DEPS[this._goblinId] || [],
          });
          delete GOBLINS_DEPS[this._goblinId];
        }
      }
    });
  }
}

module.exports = Goblin;
module.exports.Shredder = Shredder;
