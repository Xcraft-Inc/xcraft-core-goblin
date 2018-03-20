'use strict';

const watt = require('watt');
const {createStore, combineReducers, applyMiddleware} = require('redux');
const Shredder = require('xcraft-core-shredder');
const Ripley = require('./ripley.js');
const uuidV4 = require('uuid/v4');

function jsifyQuestName(quest) {
  return quest.replace(/-([a-z])/g, (m, g1) => g1.toUpperCase());
}

function createAction(type, payload, meta, error) {
  const action = isFunction(type)
    ? type
    : {
        type,
        payload,
        meta: payload.meta || {},
        error,
      };

  if (!isFunction(type)) {
    action.get = key => {
      if (action.payload[key] !== undefined) {
        return action.payload[key];
      } else {
        return action.meta[key];
      }
    };
  }
  return action;
}

function isFunction(fn) {
  return typeof fn === 'function';
}

function isGenerator(fn) {
  return (
    fn &&
    isFunction(fn) &&
    fn.constructor &&
    fn.constructor.name === 'GeneratorFunction'
  );
}

function getContextManager() {
  return {
    get: name => {
      const states = {};
      const ids = [];
      let single = false;
      Object.keys(GOBLINS[name]).forEach(k => {
        if (k === name) {
          single = true;
        }
        ids.push(k);
        states[k] = GOBLINS[name][k].store.getState();
      });
      //TODO: Call delete
      return {
        states,
        ids,
        isSingle: single && GOBLINS[name].size === 1,
        sessions: SESSIONS[name] || {},
      };
    },
    set: watt(function*(name, context, resp, next) {
      for (const id of context.ids) {
        yield resp.command.send(`${name}.create`, {id}, next);
        SESSIONS[name][id] = context.sessions[id];
        const goblin = GOBLINS[name][id];
        const state = context.states[id];
        goblin.store.dispatch({
          type: '@@RELOAD_STATE',
          state: state.logic,
        });

        if (name !== 'warehouse') {
          const data = goblin.getState().state;
          resp.command.send('warehouse.upsert', {
            branch: id,
            data: data,
          });
        }
      }
    }),
  };
}

const doAsyncQuest = watt(function*(quest, dispatch, goblin) {
  const questDispatcher = function(type, payload = {}, error = false) {
    const action = createAction(type, payload, error);
    dispatch(action);
  };
  const context = {
    dispatch: questDispatcher,
    goblin: goblin,
  };
  yield quest(context);
});

const questMiddleware = goblin => store => next => action => {
  return isFunction(action)
    ? doAsyncQuest(action, store.dispatch, goblin)
    : next(action);
};

const emptyMiddleWare = store => next => action => next(action);

function injectMessageDataGetter(msg) {
  msg.get = key => {
    if (msg.data) {
      return msg.data[key];
    }
    return null;
  };
}

function verifyMessage(msg) {
  const {topic, data} = msg;
  if (topic.endsWith('.create') || topic.endsWith('.delete')) {
    if (!data._goblinLegacy) {
      throw new Error(
        `command ${topic} is forbidden, use quest.create or quest.release`
      );
    }
  }
}

// Quest registry
const QUESTS = {};

// Quests metadata for handlers
const QUESTSMETA = {};

// Goblins registry
const GOBLINS = {};

// Goblins sessions
const SESSIONS = {};

// Configs registry
const CONFIGS = {};

let LAST_API_TIME = {};
let COMMANDS_REGISTRY = {};
let API_REGISTRY = {};
const apiBuilder = namespace => {
  Object.keys(COMMANDS_REGISTRY)
    .filter(cmd => cmd.startsWith(`${namespace}.`))
    .map(cmd => cmd.replace(/^[^.]+\./, ''))
    .filter(
      // Exclude create and _private calls and take only namespace calls
      questName =>
        `${namespace}.${questName}`.startsWith(namespace) &&
        !questName.match(/(^create$|^.+\.create$|^_.+|\._.+)/)
    )
    .map(questName => {
      return {
        call: jsifyQuestName(questName.replace(/^[a-z\-]+\./, '')),
        questName,
      };
    })
    .forEach(item => {
      if (!API_REGISTRY[namespace]) {
        API_REGISTRY[namespace] = {};
      }
      API_REGISTRY[namespace][item.call] = cmd =>
        watt(function*(payload) {
          const _payload = arguments.length < 2 ? {} : payload;
          return yield cmd(item.questName, _payload);
        });
    });
};

class Goblin {
  static getCommands() {
    return {
      start: (msg, resp) => {
        resp.events.subscribe(`*::warehouse.released`, msg => {
          msg.data
            .map(({id}) => {
              return {name: Goblin.getGoblinName(id), id};
            })
            .filter(({name, id}) => GOBLINS[name] && GOBLINS[name][id])
            .forEach(({name, id}) => {
              try {
                resp.command.send(`${name}.delete`, {
                  id,
                  _goblinLegacy: true,
                });
              } catch (ex) {
                resp.log.err(ex.stack || ex);
              }
            });
        });

        const clc = require('cli-color');
        const figlet = require('figlet');

        figlet(
          'goblin-core',
          {
            font: 'Graffiti',
            horizontalLayout: 'default',
            verticalLayout: 'default',
          },
          function(err, data) {
            if (err) {
              console.error(err);
              return;
            }

            console.log();
            console.log(
              data.replace(/[_\/\\]/g, function(match) {
                switch (match) {
                  case '_': {
                    return clc.green(match);
                  }
                  case '/': {
                    return clc.greenBright(match);
                  }
                  case '\\': {
                    return clc.blackBright(match);
                  }
                  case '|': {
                    return clc.white(match);
                  }
                }
              })
            );
            console.log();
            console.log(
              `Woooah: ready to deliver ${
                Object.keys(GOBLINS).length
              } pointy features!`
            );
            console.log();
          }
        );
        resp.events.send(`goblin.start.${msg.id}.finished`);
      },
      status: (msg, resp) => {
        const status = {};
        Object.keys(GOBLINS)
          .sort()
          .forEach(name => {
            status[name] = Object.keys(GOBLINS[name]);
            resp.log.info(`${name}:`);
            status[name].forEach(gob => {
              resp.log.info(`  ${gob}`);
            });
          });
        resp.events.send(`goblin.status.${msg.id}.finished`);
      },
    };
  }
  static registerQuest(goblinName, questName, quest) {
    if (!QUESTSMETA[goblinName]) {
      QUESTSMETA[goblinName] = {};
    }

    const xUtils = require('xcraft-core-utils');
    if (!QUESTSMETA[goblinName][questName]) {
      QUESTSMETA[goblinName][questName] = {};
    }
    QUESTSMETA[goblinName][questName].params = xUtils.reflect
      .funcParams(quest)
      .filter(param => !/^(quest|next)$/.test(param));

    /* Extract the parameters available in the msg [m] object and spreads
     * to the real command handler.
     * The first parameter is always the quest and the last can be the callback
     * function (`next` according to watt).
     */
    const _quest = (q, m, n) => {
      const args = QUESTSMETA[goblinName][questName].params.map(m.get);

      /* Pass the whole Xcraft message if asked by the quest. */
      if (!m.get('$msg')) {
        const idx = QUESTSMETA[goblinName][questName].params.indexOf('$msg');
        if (idx > -1) {
          args[idx] = m;
        }
      }

      args.unshift(q);
      if (n) {
        args.push(n);
      }

      return quest(...args);
    };

    if (!QUESTS[goblinName]) {
      QUESTS[goblinName] = {};
    }
    if (!isGenerator(quest)) {
      QUESTS[goblinName][questName] = watt(function*(q, msg) {
        return _quest(q, msg);
      });
      return;
    }
    QUESTS[goblinName][questName] = watt(_quest);
  }

  static getQuests(goblinName) {
    const quests = {};

    const createMutex = {};
    const notifyCreated = watt(function*(resp, id, msg, next) {
      if (!msg.data.createdBy) {
        throw new Error('Cannot create...');
      }
      yield resp.command.send(
        `warehouse.update-created-by`,
        {branch: id, createdBy: msg.data.createdBy},
        next
      );
      resp.events.send(`goblin.created`, {id});
      resp.events.send(`${goblinName}.create.${msg.id}.finished`, id);
    });

    Object.keys(QUESTS[goblinName]).forEach(questName => {
      //Handle create
      if (questName === 'create') {
        quests[questName] = watt(function*(msg, resp, next) {
          injectMessageDataGetter(msg);
          const id = msg.get('id') || `${goblinName}@${uuidV4()}`;
          if (id.indexOf('@') === -1) {
            throw new Error(
              `Bad goblin id provided during ${goblinName}.create, id must respect this format:
              (meta@)name@unique-identifier`
            );
          }
          if (createMutex[id]) {
            setTimeout(() => resp.command.retry(msg), 50);
            return;
          }
          const existRes = yield resp.command.send(
            `warehouse.has`,
            {path: id},
            next
          );
          if (existRes.data === true) {
            yield notifyCreated(resp, id, msg);
          } else {
            createMutex[id] = true;
            const goblin = Goblin.create(goblinName, id);
            goblin.dispatch(
              goblin.doQuest(questName, msg, resp, createMutex).bind(goblin)
            );
          }
        });
        return;
      }

      quests[questName] = (msg, resp) => {
        if (!GOBLINS[goblinName]) {
          resp.events.send(
            `${goblinName}.${questName}.${msg.id}.error`,
            new Error(
              `You must call ${goblinName}.create before calling ${questName}`
            )
          );
          return;
        }

        // Single?
        if (GOBLINS[goblinName][goblinName]) {
          const goblin = GOBLINS[goblinName][goblinName];
          goblin.dispatch(goblin.doQuest(questName, msg, resp).bind(goblin));
          return;
        }

        if (!msg.data) {
          resp.events.send(
            `${goblinName}.${questName}.${msg.id}.error`,
            new Error(`No id provided for ${goblinName}`)
          );
          return;
        }
        if (!msg.data.id) {
          resp.events.send(
            `${goblinName}.${questName}.${msg.id}.error`,
            new Error(`No id provided for ${goblinName}`)
          );
          return;
        }
        const goblin = GOBLINS[goblinName][msg.data.id];
        if (!goblin) {
          resp.events.send(
            `${goblinName}.${questName}.${msg.id}.error`,
            new Error(`Bad id ${msg.data.id} for ${goblinName}`)
          );
          return;
        }
        goblin.dispatch(goblin.doQuest(questName, msg, resp).bind(goblin));
      };
    });

    return quests;
  }

  static getGoblinName(goblinId) {
    let name = goblinId;
    if (goblinId.indexOf('@') !== -1) {
      name = goblinId.split('@')[0];
    }
    return name;
  }

  static getRC(goblinName) {
    const rc = {};

    Object.keys(QUESTS[goblinName]).forEach(questName => {
      const params = {};
      const desc = !questName.startsWith('_')
        ? `${questName} for ${goblinName}`
        : null;

      /* The reserved *.delete quests are always delayed (less priority and
       * called only when no non-delayed commands are in the waiting queue of
       * the bus commander). Same applied to warehouse.remove.
       */
      const delayed =
        questName === 'delete' ||
        (goblinName === 'warehouse' && questName === 'remove');

      const list = QUESTSMETA[goblinName][questName].params;
      params.required = list.filter(v => v[0] !== '$');
      params.optional = list.filter(v => v[0] === '$');

      rc[questName] = {
        parallel: true,
        delayed,
        desc,
        options: {
          params,
        },
      };
    });

    return rc;
  }

  static getDeps(goblinId) {
    return GOBLINS_DEPS[goblinId];
  }

  /**
   * Configure a new quest handler
   * @param {string} goblinName
   * @param {Object} logicState
   * @param {Object} logicHandlers
   * @param {Object} ripleyConfig
   */
  static configure(goblinName, logicState, logicHandlers, ripleyConfig) {
    if (!CONFIGS[goblinName]) {
      CONFIGS[goblinName] = {};
    }

    if (!SESSIONS[goblinName]) {
      SESSIONS[goblinName] = {};
    }

    CONFIGS[goblinName] = {
      logicState,
      logicHandlers,
      ripleyConfig,
    };

    if (!GOBLINS[goblinName]) {
      GOBLINS[goblinName] = {};
    }

    return {
      handlers: Goblin.getQuests(goblinName),
      context: getContextManager(),
      rc: Goblin.getRC(goblinName),
    };
  }

  static create(goblinName, uniqueIdentifier) {
    // Single ?
    if (GOBLINS[goblinName][goblinName]) {
      throw new Error('A single goblin exist');
    }
    const goblinId = uniqueIdentifier || `${goblinName}@${uuidV4()}`;

    if (GOBLINS[goblinName][goblinId]) {
      return GOBLINS[goblinName][goblinId];
    }

    GOBLINS[goblinName][goblinId] = new Goblin(
      goblinId,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].ripleyConfig
    );

    return GOBLINS[goblinName][goblinId];
  }

  static createSingle(goblinName) {
    if (GOBLINS[goblinName][goblinName]) {
      throw new Error('A single goblin exist');
    }

    GOBLINS[goblinName][goblinName] = new Goblin(
      goblinName,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].ripleyConfig
    );

    return GOBLINS[goblinName][goblinName];
  }

  static release(goblinName, goblinId) {
    delete GOBLINS[goblinName][goblinId];
    delete SESSIONS[goblinName][goblinId];
  }

  _do(questName, payload = {}, error = false) {
    if (!this._logicHasType(questName)) {
      throw new Error(`Cannot do (${questName}), missing logic handler`);
    }
    this.dispatch(questName, payload, error);
  }

  constructor(goblinId, goblinName, logicState, logicHandlers, ripleyConfig) {
    const path = require('path');
    const xConfig = require('xcraft-core-etc')().load('xcraft');

    this._goblinId = goblinId;
    this._goblinName = goblinName;
    this._logger = require('xcraft-core-log')(goblinName, null);
    this._deferrable = [];
    this._ripleyConfig = {};

    const ripleyName = `${this._goblinName}-${this._goblinId}`;

    if (ripleyConfig) {
      this._ripley = new Ripley(
        'cryo',
        path.join(xConfig.xcraftRoot, 'var/ripley'),
        ripleyName
      );

      for (const k in ripleyConfig) {
        this._ripleyConfig[k] = {};
        this._ripleyConfig[k].mode = ripleyConfig[k].mode;
        this._ripleyConfig[k].keys = ripleyConfig[k].keys;
      }
    }

    for (const k in this._ripleyConfig) {
      this._ripleyConfig[k].db = ripleyName;

      if (!('mode' in this._ripleyConfig[k])) {
        throw new Error(`Bad goblin ripley config, missing for ${k}`);
      }
      if (!this._ripley.hasMode(this._ripleyConfig[k].mode)) {
        throw new Error(`Bad goblin ripley config, unknow mode for ${k}`);
      }
    }

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
        return logicHandlers[action.type](state, action);
      }

      return state;
    };

    this._logicHasType = type => {
      return !!logicHandlers[type];
    };

    const rootReducer = combineReducers({
      engine: engineReducer,
      ellen: this._ripley
        ? this._ripley.ellen.bind(this._ripley)
        : (s = {}) => s,
      logic: logicReducer,
    });

    const initialState = {
      engine: engineState,
      ellen: this._ripley ? this._ripley.initialState : {},
      logic: new Goblin.Shredder(logicState),
    };

    this._store = createStore(
      rootReducer,
      initialState,
      applyMiddleware(
        this._ripley
          ? this._ripley.persistWith(this._ripleyConfig)
          : emptyMiddleWare,
        questMiddleware(this)
      )
    );

    if (this.useRipley) {
      this._unsubscribeRipley = this._store.subscribe(() => {
        this._logger.verb(`Saving ${this._goblinName} state...`);
        const state = this._store.getState();
        this._ripley.saveState(state.ellen.get(ripleyName));
      });
    }
  }

  get id() {
    return this._goblinId;
  }

  get goblinName() {
    return this._goblinName;
  }

  get store() {
    return this._store;
  }

  get storeListener() {
    return this._storeListener;
  }

  get useRipley() {
    return Object.keys(this._ripleyConfig).length > 0;
  }

  get locks() {
    return require('locks');
  }

  setX(key, value) {
    if (value && value._dontKeepRefOnMe) {
      throw new Error(`You cannot setX with ${key} value`);
    }
    if (!SESSIONS[this.goblinName][this.id]) {
      SESSIONS[this.goblinName][this.id] = {};
    }
    SESSIONS[this.goblinName][this.id][key] = value;
  }

  getX(key) {
    if (!SESSIONS[this.goblinName][this.id]) {
      return null;
    }
    return SESSIONS[this.goblinName][this.id][key];
  }

  delX(key) {
    delete SESSIONS[this.goblinName][this.id][key];
  }

  getState() {
    return this.store.getState().logic;
  }

  /* See https://github.com/acdlite/flux-standard-action */
  dispatch(type, payload = {}, error = false) {
    const action = createAction(type, payload, error);
    this.store.dispatch(action);
  }

  defer(action) {
    this._deferrable.push(action);
  }

  injectQuestBusHelpers(quest, resp) {
    quest._deferrable = [];
    quest.defer = func => quest._deferrable.push(func);
    quest.resp = resp;
    quest.log = resp.log;

    quest.cmdWithSideFX = watt(function*(sideFX, cmd, args, next) {
      if (arguments.length === 3) {
        next = args;
        args = null;
      }
      const msg = yield resp.command.send(cmd, args, next);
      sideFX(msg);
      return msg.data;
    });

    /**
     * send a command over bus(yield)
     * @param {string} cmd command
     */
    quest.cmd = watt(function*(cmd, args, next) {
      if (arguments.length === 2) {
        next = args;
        args = null;
      }
      const msg = yield resp.command.send(cmd, args, next);
      return msg.data;
    });

    //Inject goblins API
    quest.getAPI = (id, namespace) => {
      if (!namespace) {
        namespace = Goblin.getGoblinName(id);
      }

      const cmd = (questName, payload) =>
        quest.cmd(`${namespace}.${questName}`, Object.assign({id}, payload));

      if (LAST_API_TIME[namespace] !== resp.getCommandsRegistryTime()) {
        COMMANDS_REGISTRY = resp.getCommandsRegistry();
        LAST_API_TIME[namespace] = resp.getCommandsRegistryTime();
        apiBuilder(namespace);
      }

      const LAZY_API = {
        id,
        _dontKeepRefOnMe: true,
      };

      Object.keys(API_REGISTRY[namespace]).map(
        call => (LAZY_API[call] = API_REGISTRY[namespace][call](cmd))
      );
      return LAZY_API;
    };

    quest.openInventory = () => {
      const inventory = [];
      return {
        items: inventory,
        getAPI: (id, ns) => {
          console.warn('openInventory().getAPI is deprecated');
          quest.getAPI(id, ns);
        },
      };
    };

    quest.uuidV4 = uuidV4;

    quest.me = quest.getAPI(quest.goblin.id, quest.goblin.goblinName);

    quest.warehouse = quest.getAPI('warehouse');

    quest.release = goblinId => {
      resp.events.send(`goblin.released`, {
        id: goblinId,
      });
    };

    quest.createFor = watt(function*(
      goblinName,
      goblinId,
      namespace,
      args,
      next
    ) {
      if (!namespace) {
        throw new Error(
          'Bad create detected in ',
          goblinName,
          ' missing namespace'
        );
      }

      if (namespace.indexOf('@') !== -1) {
        namespace = namespace.split('@')[0];
      }

      const id = yield quest.cmd(
        `${namespace}.create`,
        Object.assign({createdBy: goblinId, _goblinLegacy: true}, args)
      );

      if (quest.isCanceled(id)) {
        return id;
      }

      return quest.getAPI(id, namespace);
    });

    quest.createNew = watt(function*(namespace, args) {
      if (!args) {
        args = {};
      }
      args.id = `${namespace}@${uuidV4()}`;
      namespace = args.id;
      return yield quest.createFor(
        quest.goblin.goblinName,
        quest.goblin.id,
        namespace,
        args
      );
    });

    quest.createPlugin = watt(function*(namespace, args) {
      if (!args) {
        args = {};
      }
      args.id = `${namespace}@${quest.goblin.id}`;
      return yield quest.createFor(
        quest.goblin.goblinName,
        quest.goblin.id,
        namespace,
        args
      );
    });

    quest.create = watt(function*(namespace, args) {
      return yield quest.createFor(
        quest.goblin.goblinName,
        quest.goblin.id,
        namespace,
        args
      );
    });

    quest.evt = function(customed, payload) {
      if (!payload) {
        payload = {};
      }
      if (payload._isSuperReaper6000) {
        payload = payload.state;
      }
      resp.events.send(`${quest.goblin.id}.${customed}`, payload);
    };

    quest.evt.send = (topic, payload) => {
      resp.events.send(
        `${quest.goblin.id.replace(/@.*/, '')}.${topic}`,
        payload
      );
    };

    quest.sub = function(topic, handler) {
      return resp.events.subscribe(topic, msg => handler(null, msg));
    };

    quest.sub.wait = watt(function*(topic, next) {
      const _next = next.parallel();
      const unsubWait = resp.events.subscribe(topic, msg => _next(null, msg));
      const res = yield next.sync();
      unsubWait();
      if (res.length > 0) {
        return res[0].data;
      }
    });

    quest.cancel = () => {
      return {
        _QUEST_CANCELED_: true,
        id: quest.goblin.id,
        name: quest.goblin.goblinName,
      };
    };

    quest.isCanceled = result => {
      if (result && result._QUEST_CANCELED_) {
        return true;
      }
      return false;
    };

    quest.getDesktop = () => {
      const d = quest.goblin.getX('desktopId');
      if (!d) {
        throw new Error(`unable to get desktop id in ${quest.goblinId}`);
      }
      return d;
    };
    quest.getSession = () => quest.getDesktop().split('@')[1];
    quest.getStorage = service =>
      quest.getAPI(`${service}@${quest.getSession()}`);
  }

  ///////// ║ ┼ Do quest! ┼ ║ ////////
  /// Welcome to the source core, dear goblin explorator!
  ///
  doQuest(questName, msg, resp, createMutex) {
    return watt(function*(quest, next) {
      verifyMessage(msg);
      injectMessageDataGetter(msg);
      this.injectQuestBusHelpers(quest, resp);
      //////////////////////////////////////////////////////////////////
      ///State save/load
      ///Ripley purpose... not documented, not used for the moment...
      quest.loadState = watt(function*(next) {
        quest.log.verb('Loading state...');
        if (this.useRipley) {
          quest.log.verb('Ripleying...');
          yield this._ripley.ripley(this._store, resp.log, next);
          quest.log.verb('Ripleying [done]');
        } else {
          quest.log.verb('nothing to Ripley (empty config)');
        }
        quest.log.verb('Loading state [done]');
      }).bind(this);

      quest.saveState = watt(function*(next) {
        quest.log.verb('Saving state...');
        const state = this._store.getState();
        this._ripley.saveState(state.ellen.get(this._goblinName));
        yield this._ripley.waitForWrites();
        quest.log.verb('Saving state [done]');
      }).bind(this);
      ////////////////////////////////////////////////////////////////////

      //Track possibles goblin state mutations with this var:
      let questHasDispatched = false;
      //The fame' quest.do () shortcut, is injected here
      quest.do = (action = {}, ...args) => {
        action.meta = msg.data;
        questHasDispatched = true;
        return this._do(questName, action, msg.data, ...args);
      };
      const realDispatch = quest.dispatch;
      quest.dispatch = (...args) => {
        questHasDispatched = true;
        realDispatch(...args);
      };

      quest.log.verb('Starting quest...');
      quest.dispatch('STARTING_QUEST', {questName, msg});

      let result = null;
      let errThrown = false;
      let canceled = false;
      try {
        this.getState().attachLogger(resp.log);

        //Only execute create quest on the first creation
        if (questName === 'create') {
          //console.log ('RUNNING CREATE QUEST:', this._goblinId);
          result = yield QUESTS[this._goblinName][questName](quest, msg);
        }

        //Only execute delete quest when we are the last brave goblin
        if (questName === 'delete') {
          //console.log ('RUNNING DELETE QUEST:', this._goblinId);
          yield QUESTS[this._goblinName][questName](quest, msg);
        }

        //In other case execute!
        if (questName !== 'create' && questName !== 'delete') {
          result = yield QUESTS[this._goblinName][questName](quest, msg);
        }

        //Create must return the goblin id if not provided
        if (questName === 'create' && !result) {
          result = this._goblinId;
        }

        //Handle return quest.cancel () result
        if (result && result._QUEST_CANCELED_) {
          canceled = true;
        }

        // Here we send the new goblin state to the warehouse
        if (
          this.goblinName !== 'warehouse' &&
          questName !== 'delete' &&
          !canceled
        ) {
          quest.log.verb(`${this.goblinName} upserting`);
          // hide private branch of state
          const isSingleton = this.goblinName === this._goblinId;
          const createdBy = msg.data ? msg.data.createdBy : null;
          if (questName === 'create' && !createdBy && !isSingleton) {
            throw new Error(
              `Fatal error ${msg.topic} missing createdBy parameter`
            );
          }

          let toUpsert = this.getState().state.delete('private');
          if (toUpsert.size === 0) {
            toUpsert = Shredder.fromJS({id: this._goblinId});
          }

          if (!toUpsert.has('id') && !isSingleton) {
            throw new Error(
              `Fatal error missing property id in ${this._goblinId}`
            );
          }

          const payload = {
            branch: this._goblinId,
            data: toUpsert,
          };

          if (questName === 'create' || isSingleton) {
            payload.createdBy = createdBy || this._goblinId;
            if (!questHasDispatched && !isSingleton) {
              throw new Error(
                'Your forgot to call quest.do () in create quest of ',
                this.goblinName
              );
            }
          }

          if (questHasDispatched) {
            yield quest.cmd('warehouse.upsert', payload);
          }
        }
      } catch (ex) {
        errThrown = true;
        const err = ex.stack || ex;
        resp.events.send(`${this.goblinName}.${questName}.${msg.id}.error`, ex);
        quest.log.err(`quest [${questName}] failure: ${err}`);
        if (err.stack) {
          quest.log.err(`stack: ${err.stack}`);
        }
      } finally {
        quest.log.verb('Ending quest...');
        quest.dispatch('ENDING_QUEST');
        this.getState().detachLogger();
        //QUEST DEFER SCOPED
        while (quest._deferrable.length > 0) {
          quest._deferrable.pop()();
        }

        if (!errThrown) {
          //Finally, notify others that a new goblin is born
          if (questName === 'create' && !canceled) {
            resp.events.send(`goblin.created`, {
              id: this._goblinId,
            });
          }

          if (questName === 'delete' && !canceled) {
            //GOBLIN DELETE QUEST DEFER SCOPED
            while (this._deferrable.length > 0) {
              this._deferrable.pop()();
            }
            if (this.useRipley) {
              this._unsubscribeRipley();
            }

            Goblin.release(this.goblinName, this._goblinId);
            resp.events.send(`goblin.deleted`, {
              id: this._goblinId,
            });
          }

          // FINISHED
          resp.events.send(
            `${this.goblinName}.${questName}.${msg.id}.finished`,
            result
          );
          if (createMutex) {
            delete createMutex[this._goblinId];
          }
        }
      }
    });
  }
}

module.exports = Goblin;
module.exports.Shredder = Shredder;
