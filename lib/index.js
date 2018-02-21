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

// Quest registry
const QUESTS = {};

// Quests metadata for handlers
const QUESTSMETA = {};

// Goblins registry
const GOBLINS = {};

// Goblin refcount
const GOBLINS_REFS = {};

// Goblins owned usable services
const GOBLINS_USES = {};

const GOBLINS_DEPS = {};

// Goblins sessions
const SESSIONS = {};

// Configs registry
const CONFIGS = {};

class Goblin {
  static getCommands() {
    return {
      status: (msg, resp) => {
        const status = {};
        Object.keys(GOBLINS).forEach(name => {
          status[name] = Object.keys(GOBLINS[name]);
          resp.log.info(`${name}:`);
          status[name].forEach(gob => {
            resp.log.info(`  ${gob}`);
            if (GOBLINS_REFS[gob]) {
              resp.log.info(`  - refcount=${GOBLINS_REFS[gob].count}`);
            }
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

    Object.keys(QUESTS[goblinName]).forEach(questName => {
      //Handle create
      if (questName === 'create') {
        quests[questName] = (msg, resp) => {
          injectMessageDataGetter(msg);
          const id = msg.get('id') || `${goblinName}@${uuidV4()}`;
          if (id.indexOf('@') === -1) {
            throw new Error(
              `Bad gobelin id provided during ${goblinName}.create, id must respect this format:
              (meta@)name@unique-identifier`
            );
          }
          const goblin = Goblin.create(goblinName, id);
          goblin.dispatch(goblin.doQuest(questName, msg, resp).bind(goblin));
        };
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

  static isDepOf(whichGoblinId, whereGoblinId) {
    if (whichGoblinId === whereGoblinId) {
      return true; //To be or not to be, dep of itself ?!
    }
    return GOBLINS_DEPS[whereGoblinId].indexOf(whichGoblinId) !== -1;
  }

  static hasDepOfType(whereGoblinId, whichGoblin) {
    if (!GOBLINS_DEPS[whereGoblinId]) {
      return false;
    }
    return (
      Object.keys(GOBLINS_DEPS[whereGoblinId])
        .map(k => Goblin.getGoblinName(GOBLINS_DEPS[whereGoblinId][k]))
        .indexOf(whichGoblin) !== -1
    );
  }

  static getRootDep(whereGoblinId) {
    if (!GOBLINS_DEPS[whereGoblinId]) {
      return null;
    }

    if (GOBLINS_DEPS[whereGoblinId].length === 0) {
      return null;
    }

    return GOBLINS_DEPS[whereGoblinId][0];
  }

  static getOwnDirectDeps(whichGoblinId) {
    const deps = Object.keys(GOBLINS_DEPS)
      .filter(g => g !== whichGoblinId) // Skip itself
      .filter(g => GOBLINS_DEPS[g][0] === whichGoblinId); // return only deps with me as root dep
    return deps;
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
      GOBLINS_USES[goblinName] = {};
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

    //REFCOUNT
    if (!GOBLINS_REFS[goblinId]) {
      GOBLINS_REFS[goblinId] = {
        count: 0,
      };
    }

    GOBLINS_REFS[goblinId].count++;

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

    GOBLINS_USES[goblinName][goblinId] = {};
    return GOBLINS[goblinName][goblinId];
  }

  static createSingle(goblinName) {
    if (GOBLINS[goblinName][goblinName]) {
      throw new Error('A single goblin exist');
    }

    //REFCOUNT
    GOBLINS_REFS[goblinName] = {
      count: 1,
    };

    GOBLINS[goblinName][goblinName] = new Goblin(
      goblinName,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].ripleyConfig
    );
    GOBLINS_USES[goblinName][goblinName] = {};
    return GOBLINS[goblinName][goblinName];
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
      ellen: this._ripley ? this._ripley.ellen : (s = {}) => s,
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

    quest.countRef = goblinId => {
      return GOBLINS_REFS[goblinId].count;
    };

    //Inject goblins API
    quest.getGoblinAPI = (namespace, id) => {
      const api = {
        id,
        _dontKeepRefOnMe: true,
      };
      const goblin = /^[^.]+/.exec(namespace)[0];

      Object.keys(resp.getCommandsRegistry())
        .filter(cmd => cmd.startsWith(`${goblin}.`))
        .map(cmd => cmd.replace(/^[^.]+\./, ''))
        .filter(
          // Exclude create and _private calls and take only namespace calls
          questName =>
            `${goblin}.${questName}`.startsWith(namespace) &&
            !questName.match(/(^create$|^.+\.create$|^_.+|\._.+)/)
        )
        .map(questName => {
          return {
            call: jsifyQuestName(questName.replace(/^[a-z\-]+\./, '')),
            questName,
          };
        })
        .forEach(
          item =>
            (api[item.call] = watt(function*(payload) {
              const _payload = arguments.length < 2 ? {} : payload;
              return yield quest.cmd(
                `${goblin}.${item.questName}`,
                Object.assign(
                  {
                    id,
                  },
                  _payload
                )
              );
            }))
        );

      return api;
    };

    quest.useAs = function(namespace, id) {
      if (!GOBLINS_REFS[id] || GOBLINS_REFS[id].count === 0) {
        throw new Error(`No goblin instances available for ${id}`);
      }

      //I have already used that instance ?
      if (!GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id][id]) {
        //No, increment refcount, and set usage
        GOBLINS_REFS[id].count++;
        //console.log (id, ' -> ', GOBLINS_REFS[id]);
        GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id][id] = {
          namespace,
          id,
        };
      }

      return quest.getGoblinAPI(namespace, id);
    };

    quest.getAPI = useKey => {
      if (!useKey) {
        throw new Error(`Undefined useKey`);
      }

      if (!GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id][useKey]) {
        throw new Error(`Your are not owner of ${useKey}`);
      }

      const {namespace, id} = GOBLINS_USES[quest.goblin.goblinName][
        quest.goblin.id
      ][useKey];

      return quest.getGoblinAPI(namespace, id);
    };

    quest.use = function(useKey) {
      if (!useKey) {
        throw new Error(`Undefined useKey`);
      }

      if (!GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id][useKey]) {
        throw new Error(`Your are not owner of ${useKey}`);
      }

      const {namespace, id} = GOBLINS_USES[quest.goblin.goblinName][
        quest.goblin.id
      ][useKey];

      return quest.useAs(namespace, id);
    };

    quest.canUse = useKey => {
      if (!GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id]) {
        return false;
      }
      return !!GOBLINS_USES[quest.goblin.goblinName][quest.goblin.id][useKey];
    };

    quest.openInventory = () => {
      const inventory = [];

      Object.keys(GOBLINS_USES).forEach(goblin =>
        Object.keys(GOBLINS_USES[goblin]).forEach(id => {
          inventory.push({id, namespace: Goblin.getGoblinName(id)});
        })
      );

      const matchByNamespace = (use, namespace) => {
        return use.namespace === namespace;
      };

      return {
        items: inventory,
        find: namespace =>
          inventory.find(use => matchByNamespace(use, namespace)),
        useAny: namespace => {
          const use = inventory.find(use => matchByNamespace(use, namespace));
          return use ? quest.useAs(use.namespace, use.id) : null;
        },
        use: useId => {
          const use = inventory.find(use => use.id === useId);
          return use ? quest.useAs(use.namespace, use.id) : null;
        },
        getAPI: useId => {
          const use = inventory.find(use => use.id === useId);
          return use ? quest.getGoblinAPI(use.namespace, use.id) : null;
        },
        hasAny: namespace => {
          return !!inventory.find(use => matchByNamespace(use, namespace));
        },
        has: useId => {
          return !!inventory.find(use => use.id === useId);
        },
      };
    };

    quest.uuidV4 = uuidV4;

    quest.me = quest.getGoblinAPI(quest.goblin.goblinName, quest.goblin.id);

    quest.warehouse = quest.getGoblinAPI('warehouse', 'warehouse');

    quest.createFor = watt(function*(
      goblinName,
      goblinId,
      namespace,
      args,
      next
    ) {
      let useRef = null;
      let useKey = namespace;
      if (!namespace) {
        throw new Error('Bad create detected in ', goblinName);
      }
      if (namespace.indexOf('@') !== -1) {
        namespace = namespace.split('@')[0];
      }

      let skipCreate = false;
      if (GOBLINS[namespace] && GOBLINS[namespace][useKey]) {
        skipCreate = true;
      }

      if (!GOBLINS_USES[goblinName][goblinId]) {
        throw new Error(`Unknow goblin ${goblinName} with id ${goblinId}`);
      }

      if (GOBLINS_USES[goblinName][goblinId][useKey]) {
        return quest.getGoblinAPI(
          namespace,
          GOBLINS_USES[goblinName][goblinId][useKey].id
        );
      }

      GOBLINS_USES[goblinName][goblinId][useKey] = {};
      useRef = GOBLINS_USES[goblinName][goblinId][useKey];
      useRef.namespace = namespace;

      let id = null;
      if (skipCreate) {
        id = useKey;

        GOBLINS_REFS[id].count++;
        resp.events.send(`goblin.created`, {id});

        const uses = Object.assign({}, GOBLINS_USES[namespace][id]);

        const useMore = cGob => {
          console.log('Using ', cGob._goblinId);
          const sUses = Object.assign(
            {},
            GOBLINS_USES[cGob.goblinName][cGob._goblinId]
          );
          GOBLINS_REFS[cGob._goblinId].count++;
          resp.events.send(`goblin.created`, {id: cGob._goblinId});

          for (const s in sUses) {
            const suse = sUses[s];
            const scGob = GOBLINS[suse.namespace][suse.id];
            if (scGob !== undefined) {
              useMore(scGob);
            }
          }
        };

        for (const g in uses) {
          const use = uses[g];
          const cGob = GOBLINS[use.namespace][use.id];
          if (cGob !== undefined) {
            useMore(cGob);
          }
        }
      } else {
        id = yield quest.cmdWithSideFX(
          msg => {
            if (quest.isCanceled(msg.data)) {
              return msg.data;
            }
            const id = msg.data;
            GOBLINS_DEPS[id] = [];
            const deps = GOBLINS_DEPS[goblinId] || [goblinId];
            GOBLINS_DEPS[id].push(...deps, id);
            return id;
          },
          `${namespace}.create`,
          args
        );
      }

      if (quest.isCanceled(id)) {
        return id;
      }

      useRef.id = id || namespace;

      return quest.getGoblinAPI(namespace, id);
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
  }

  ///////// ║ ┼ Do quest! ┼ ║ ////////
  /// Welcome to the source core, dear goblin explorator!
  ///
  doQuest(questName, msg, resp) {
    return watt(function*(quest, next) {
      //Prevent useless run's
      if (
        !GOBLINS_REFS[this._goblinId] ||
        GOBLINS_REFS[this._goblinId].count === 0
      ) {
        // FINISHED
        resp.events.send(
          `${this.goblinName}.${questName}.${msg.id}.finished`,
          null
        );
        return;
      }

      ///We keep a copy of all uses, at this point,
      ///used for refcounting more usages in case of goblin creation, and releasing correctly
      ///when a goblin deletion occur.
      const uses = Object.assign(
        {},
        GOBLINS_USES[this.goblinName][this._goblinId]
      );

      if (questName === 'create') {
        /*console.log (
          'CREATING: ',
          this._goblinId,
          '(',
          GOBLINS_REFS[this._goblinId],
          ')'
        );*/

        //We increment the same used ressources
        //when other goblin's instance (same id) is created
        //the first pass (refcount 1) has already
        //setting a first count on ressources...
        if (GOBLINS_REFS[this._goblinId].count > 1) {
          for (const g in uses) {
            const use = uses[g];
            GOBLINS_REFS[use.id].count++;
          }
        }
      }

      if (questName === 'delete') {
        /*console.log (
          'DELETING: ',
          this._goblinId,
          '(',
          GOBLINS_REFS[this._goblinId],
          ')'
        );*/

        //If a race quest would delete the last,
        //don't panic, don't decrement again,
        //we must just have 0 ref after this point.
        if (GOBLINS_REFS[this._goblinId].count >= 1) {
          GOBLINS_REFS[this._goblinId].count--;
        }
      }

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
        yield this._ripley.waitForWrites(next);
        quest.log.verb('Saving state [done]');
      }).bind(this);
      ////////////////////////////////////////////////////////////////////

      //The fame' quest.do () shortcut, is injected here
      quest.do = (action = {}, ...args) => {
        action.meta = msg.data;
        return this._do(questName, action, msg.data, ...args);
      };

      quest.log.verb('Starting quest...');
      quest.dispatch('STARTING_QUEST', {questName, msg});

      let result = null;
      let errThrown = false;
      let canceled = false;
      try {
        this.getState().attachLogger(resp.log);

        //Only execute create quest on the first creation
        if (
          questName === 'create' &&
          GOBLINS_REFS[this._goblinId].count === 1
        ) {
          //console.log ('RUNNING CREATE QUEST:', this._goblinId);
          result = yield QUESTS[this._goblinName][questName](quest, msg);
        }

        //Only execute delete quest when we are the last brave goblin
        if (
          questName === 'delete' &&
          GOBLINS_REFS[this._goblinId].count === 0
        ) {
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
          //When we cancel a create,
          if (questName === 'create') {
            if (GOBLINS_REFS[this._goblinId].count >= 1) {
              GOBLINS_REFS[this._goblinId].count--;
            }
          }
        }

        // Here we send the new goblin state to the warehouse
        if (
          this.goblinName !== 'warehouse' &&
          questName !== 'delete' &&
          !canceled
        ) {
          quest.log.verb(`${this.goblinName} upserting`);
          // hide private branch of state
          const toUpsert = this.getState().state.delete('private');

          // XXX: Prevent empty state for the branches; need to
          // to investigate because it smells like a bug.
          if (toUpsert.size > 0) {
            if (GOBLINS.warehouse && GOBLINS.warehouse.warehouse) {
              // HACK: optimize by short-circuit
              const warehouseGoblin = GOBLINS.warehouse.warehouse;
              const action = {
                branch: this._goblinId,
                data: toUpsert,
              };
              action.meta = {data: action.data};
              injectMessageDataGetter(action);
              warehouseGoblin.dispatch('upsert', action);
            } else {
              quest.cmd('warehouse.upsert', {
                branch: this._goblinId,
                data: toUpsert,
              });
            }
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

          //Finally, look for cleaning the stack
          if (questName === 'delete') {
            if (GOBLINS_REFS[this._goblinId].count === 0) {
              //console.log ('CLEANING:', this._goblinId);
              //GOBLIN DELETE QUEST DEFER SCOPED
              while (this._deferrable.length > 0) {
                this._deferrable.pop()();
              }

              //Remove me from warehouse
              quest.cmd('warehouse.remove', {
                branch: this._goblinId,
              });

              //Free stack maps...

              const deps = GOBLINS_DEPS[this._goblinId] || [];

              delete GOBLINS_DEPS[this._goblinId];
              delete GOBLINS_USES[this.goblinName][this._goblinId];
              delete GOBLINS_REFS[this._goblinId];
              delete GOBLINS[this.goblinName][this._goblinId];
              delete SESSIONS[this.goblinName][this._goblinId];

              if (this.useRipley) {
                this._unsubscribeRipley();
              }

              //notify other that we are not longuer available...
              resp.events.send(`goblin.deleted`, {
                id: this._goblinId,
                deps,
              });
            }

            //a falling goblin dominos is started here,
            //recursive release of REFS, tag for cleaning
            //only some will survive...
            const postRelease = [];
            const dominos = dGob => {
              console.log('Releasing ', dGob._goblinId);
              const sUses = Object.assign(
                {},
                GOBLINS_USES[dGob.goblinName][dGob._goblinId]
              );

              if (GOBLINS_REFS[dGob.id].count >= 1) {
                GOBLINS_REFS[dGob.id].count--;
              }

              if (GOBLINS_REFS[dGob.id].count === 0) {
                postRelease[dGob.id] = dGob;
              }

              for (const s in sUses) {
                const suse = sUses[s];
                if (!GOBLINS[suse.namespace]) {
                  continue;
                }
                const sdGob = GOBLINS[suse.namespace][suse.id];
                if (sdGob !== undefined) {
                  dominos(sdGob);
                }
              }
            };

            //Start dominos here:
            for (const g in uses) {
              const use = uses[g];
              if (!GOBLINS[use.namespace]) {
                continue;
              }
              const dGob = GOBLINS[use.namespace][use.id];
              if (dGob !== undefined) {
                dominos(dGob);
              }
            }

            Object.keys(postRelease).map(k => {
              const dGob = postRelease[k];
              console.log('Cleaning ', dGob._goblinId);
              while (dGob._deferrable.length > 0) {
                dGob._deferrable.pop()();
              }
              //Free stack maps...

              delete GOBLINS_DEPS[dGob._goblinId];
              delete GOBLINS_USES[dGob.goblinName][dGob._goblinId];
              delete GOBLINS_REFS[dGob._goblinId];
              delete GOBLINS[dGob.goblinName][dGob._goblinId];

              //We mimic a delete call from good goblin
              const dQuest = {};
              const dMsg = {
                data: {id: dGob._goblinId},
              };
              dQuest.goblin = dGob;
              injectMessageDataGetter(dMsg);
              dGob.injectQuestBusHelpers(dQuest, resp);
              QUESTS[dGob.goblinName].delete(dQuest, dMsg, () => {
                delete SESSIONS[dGob.goblinName][dGob._goblinId];
              });
            });

            if (Object.keys(postRelease).length > 0) {
              //notify others in batch for all casualities...
              //with that, laboratory can remove in batch too...
              resp.events.send(`goblin.deleted-in-batch`, {
                ids: Object.keys(postRelease).map(k => k),
              });

              //Remove in batch from warehouse
              quest.cmd('warehouse.remove-batch', {
                branches: Object.keys(postRelease).map(k => k),
              });
            }

            //console.log ('DELETING: [DONE]', this._goblinId);
          }

          // FINISHED
          resp.events.send(
            `${this.goblinName}.${questName}.${msg.id}.finished`,
            result
          );
        }
      }
    });
  }
}

module.exports = Goblin;
module.exports.Shredder = Shredder;
