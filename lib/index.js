'use strict';

const path = require('path');
const watt = require('watt');
const {createStore, combineReducers, applyMiddleware} = require('redux');
const Shredder = require('xcraft-core-shredder');
const xUtils = require('xcraft-core-utils');
const {jsify} = xUtils.string;
const goblinConfig = require('xcraft-core-etc')().load('xcraft-core-goblin');
const Ripley = require('./ripley.js');
const uuidV4 = require('uuid/v4');
const _ = require('lodash');

const enableDevTools =
  process.env.GOBLIN_DEVTOOLS && parseInt(process.env.GOBLIN_DEVTOOLS) === 1;

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
      if (Shredder.isImmutable(msg.data[key])) {
        return new Shredder(msg.data[key]);
      }
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

// Goblins alias registry
const ALIAS = {};

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
        call: jsify(questName.replace(/^[a-z-]+\./, '')),
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

class Quest {
  constructor(resp, msg) {
    this._deferrable = [];

    this.resp = resp;
    this.msg = msg;
    this.log = this.resp.log;
    this.uuidV4 = uuidV4;

    this.__proto__.evt.__proto__.send = (topic, payload) => {
      this.resp.events.send(
        `${this.goblin.id.replace(/@.*/, '')}.${topic}`,
        payload
      );
    };

    this.__proto__.sub.__proto__.wait = watt(function*(topic, next) {
      const _next = next.parallel();
      const unsubWait = this.resp.events.subscribe(topic, msg =>
        _next(null, msg)
      );
      const res = yield next.sync();
      unsubWait();
      if (res.length > 0) {
        return res[0].data;
      }
    });

    watt.wrapAll(this);
  }

  defer(func) {
    this._deferrable.push(func);
  }

  /**
   * send a command over bus(yield)
   *
   * @param {string} cmd - command name.
   * @param {Array} args - List of command arguments.
   * @param {function} next - Watt's callback.
   * @returns {Object} the results.
   */
  *cmd(cmd, args, next) {
    if (arguments.length === 2) {
      next = args;
      args = null;
    }
    const msg = yield this.resp.command.send(cmd, args, next);
    return msg.data;
  }

  //Inject goblins API
  getAPI(id, namespace) {
    if (!id) {
      throw new Error(`Missing id for getting an API`);
    }

    if (!namespace) {
      namespace = Goblin.getGoblinName(id);
    }

    const cmd = (questName, payload) =>
      this.cmd(`${namespace}.${questName}`, Object.assign({id}, payload));

    if (LAST_API_TIME[namespace] !== this.resp.getCommandsRegistryTime()) {
      COMMANDS_REGISTRY = this.resp.getCommandsRegistry();
      LAST_API_TIME[namespace] = this.resp.getCommandsRegistryTime();
      apiBuilder(namespace);
    }

    if (!API_REGISTRY[namespace]) {
      throw new Error(`Missing module for namespace: ${namespace}`);
    }

    const LAZY_API = {
      id,
      _dontKeepRefOnMe: true,
    };

    Object.keys(API_REGISTRY[namespace]).map(
      call => (LAZY_API[call] = API_REGISTRY[namespace][call](cmd))
    );
    return LAZY_API;
  }

  openInventory() {
    const inventory = [];
    return {
      items: inventory,
      getAPI: (id, ns) => {
        console.warn('openInventory().getAPI is deprecated');
        this.getAPI(id, ns);
      },
    };
  }

  get me() {
    return this.getAPI(this.goblin.id, this.goblin.goblinName);
  }

  get warehouse() {
    return this.getAPI('warehouse');
  }

  release(goblinId) {
    this.resp.events.send(`goblin.released`, {
      id: goblinId,
    });
  }

  *kill(ids, owners, next) {
    if (arguments.length === 2) {
      next = owners;
      owners = null;
    }
    if (ids && !Array.isArray(ids)) {
      ids = [ids];
    }
    if (owners && !Array.isArray(owners)) {
      owners = [owners];
    }
    for (const id of ids) {
      this.warehouse.removeCreatedBy(
        {
          owners: owners || [this.goblin.id],
          branch: id,
        },
        next.parallel()
      );
    }
    yield next.sync();
    yield this.warehouse.collect();
  }

  *createFor(
    goblinName, // TODO: only used for logging, it should be removed
    goblinId,
    namespace,
    args
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

    if (!args.desktopId) {
      args.desktopId = this.getDesktop(true);
    }

    let feed;
    if (args && args._goblinFeed) {
      feed = args._goblinFeed;
    } else {
      const ownerName = Goblin.getGoblinName(goblinId);
      if (GOBLINS[ownerName] && GOBLINS[ownerName][goblinId]) {
        feed = GOBLINS[ownerName][goblinId].feed;
      } else {
        feed = this.goblin.feed;
      }
    }

    const id = yield this.cmd(
      `${namespace}.create`,
      Object.assign(
        {
          createdBy: goblinId,
          _goblinLegacy: true,
          _goblinFeed: feed,
        },
        args
      )
    );

    if (this.isCanceled(id)) {
      return id;
    }

    return this.getAPI(id, namespace);
  }

  *createNew(namespace, args) {
    if (!args) {
      args = {};
    }
    args.id = `${namespace}@${uuidV4()}`;
    namespace = args.id;
    return yield this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  *createPlugin(namespace, args) {
    if (!args) {
      args = {};
    }
    args.id = `${namespace}@${this.goblin.id}`;
    return yield this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  *create(namespace, args) {
    return yield this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  getState(goblinId) {
    const namespace = Goblin.getGoblinName(goblinId);
    if (GOBLINS[namespace] && GOBLINS[namespace][goblinId]) {
      return GOBLINS[namespace][goblinId].getState();
    } else {
      return null;
    }
  }

  evt(customed, payload) {
    if (!payload) {
      payload = {};
    }
    if (payload._isSuperReaper6000) {
      payload = payload.state;
    }
    this.resp.events.send(`${this.goblin.id}.${customed}`, payload);
  }

  sub(topic, handler) {
    if (isGenerator(handler)) {
      handler = watt(handler);
    }
    return this.resp.events.subscribe(topic, msg => handler(null, msg));
  }

  cancel() {
    return {
      _QUEST_CANCELED_: true,
      id: this.goblin.id,
      name: this.goblin.goblinName,
    };
  }

  isCanceled(result) {
    return result && result._QUEST_CANCELED_;
  }

  fail(title, desc, hint, ex) {
    const msg = `${title}

    ${desc}
    hint:
    ${hint}
    service:
    ${this.goblin.goblinName}
    id:
    ${this.goblin.id}
    ex:
    ${ex.stack || ex.message || ex}`;

    const desktop = this.getDesktop(true);
    if (desktop) {
      const dAPI = this.getAPI(desktop);
      const notificationId = `err-notif@${this.goblin.id}`;
      dAPI.addNotification({
        notificationId,
        glyph: 'solid/exclamation-triangle',
        color: 'red',
        message: msg,
      });
    } else {
      console.log(msg);
    }
  }

  getDesktop(canFail) {
    let d = this.goblin.getX('desktopId');
    if (!d) {
      d = this.msg.data.desktopId;
      if (!d) {
        if (!canFail) {
          throw new Error(`unable to get desktop id in ${this.goblin.id}`);
        }
      }
    }
    return d;
  }

  getSession() {
    return this.getDesktop().split('@')[1];
  }

  getStorage(service) {
    return this.getAPI(`${service}@${this.getSession()}`);
  }
}

class Goblin {
  static getCommands() {
    return {
      start: watt(function*(msg, resp, next) {
        resp.events.subscribe(`*::warehouse.released`, msg => {
          msg.data
            .map(({id}) => {
              return {name: Goblin.getGoblinName(id), id};
            })
            .filter(
              ({name, id}) => GOBLINS[name] && GOBLINS[name][id] && name !== id
            )
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

        console.log();
        console.log(yield xUtils.log.graffiti('goblin-core', next));
        console.log();
        console.log(
          `Woooah: ready to deliver ${
            Object.keys(GOBLINS).length
          } pointy features!`
        );
        console.log();

        resp.events.send(`goblin.start.${msg.id}.finished`);
      }),
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
    const notifyCreated = (resp, id, msg, feed) => {
      if (!msg.data.createdBy) {
        throw new Error('Cannot create...');
      }
      resp.events.send(`${id}.created`, {
        id,
      });
      resp.events.send(`goblin.${feed}.created`, {id});
      resp.events.send(`${goblinName}.create.${msg.id}.finished`, id);
    };

    Object.keys(QUESTS[goblinName]).forEach(questName => {
      //Handle create
      if (questName === 'create') {
        quests[questName] = watt(function*(msg, resp, next) {
          try {
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
              `warehouse.update-created-by`,
              {branch: id, createdBy: msg.data.createdBy},
              next
            );

            let goblin =
              GOBLINS[goblinName] && GOBLINS[goblinName][msg.data.id];

            // Hum?
            // goblin instance must exist or
            // not while the branch exist in the warehouse ?

            if (goblin && existRes.data === true) {
              const feed = msg.data && msg.data._goblinFeed;
              if (feed) {
                Object.assign(goblin.feed, feed);
              }
              if (Object.keys(goblin.feed).length > 0) {
                for (const feedId in goblin.feed) {
                  notifyCreated(resp, id, msg, feedId, next.parallel());
                }
                yield next.sync();
              } else {
                resp.events.send(`${goblinName}.create.${msg.id}.finished`, id);
              }
              return;
            }

            if (goblin) {
              setTimeout(() => resp.command.retry(msg), 50);
              return;
            }

            createMutex[id] = true;
            goblin = Goblin.create(goblinName, id);
            const feed = msg.data && msg.data._goblinFeed;
            if (feed) {
              Object.assign(goblin.feed, feed);
            }
            goblin.dispatch(
              goblin.doQuest(questName, msg, resp, createMutex).bind(goblin)
            );
          } catch (ex) {
            resp.events.send(`${goblinName}.${questName}.${msg.id}.error`, {
              code: ex.code,
              message: ex.message,
              stack: ex.stack,
            });
          }
        });
        return;
      }

      const questDelete = (msg, resp) => {
        if (!msg.data._goblinMutexRecursive && createMutex[msg.data.id]) {
          setTimeout(() => resp.command.retry(msg), 50);
          return false;
        }

        createMutex[msg.data.id] = true;
        return true;
      };

      quests[questName] = (msg, resp) => {
        try {
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
            throw new Error(`No id provided for ${goblinName}.${questName}`);
          }
          if (!msg.data.id) {
            throw new Error(`No id provided for ${goblinName}.${questName}`);
          }
          const goblin = GOBLINS[goblinName][msg.data.id];
          if (!goblin) {
            throw new Error(
              `Bad id ${msg.data.id} for ${goblinName}.${questName}`
            );
          }

          if (questName === 'delete' && !questDelete(msg, resp)) {
            return;
          }

          goblin.dispatch(
            goblin.doQuest(questName, msg, resp, createMutex).bind(goblin)
          );
        } catch (ex) {
          resp.events.send(`${goblinName}.${questName}.${msg.id}.error`, {
            code: ex.code,
            message: ex.message,
            stack: ex.stack,
          });
        }
      };
    });

    return quests;
  }

  static extractGoblinName(goblinId) {
    let name = goblinId;
    if (goblinId.indexOf('@') !== -1) {
      name = goblinId.split('@')[0];
    }
    return name;
  }

  static getGoblinName(goblinId) {
    const alias = Goblin.extractGoblinName(goblinId);
    return ALIAS[alias] || alias;
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

    if (
      Object.keys(QUESTSMETA[goblinName]).filter(
        k => k === 'init' || k === 'boot'
      ).length > 0
    ) {
      throw new Error(`Cannot create goblin ${goblinName}: singleton reserved quest names found in your goblin,
      please rename 'init' or 'boot' quests to something else`);
    }
    const goblinId = uniqueIdentifier || `${goblinName}@${uuidV4()}`;

    if (GOBLINS[goblinName][goblinId]) {
      return GOBLINS[goblinName][goblinId];
    }

    const alias = Goblin.extractGoblinName(goblinId);
    if (alias !== goblinName && !ALIAS[alias]) {
      ALIAS[alias] = goblinName;
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
    this._goblinId = goblinId;
    this._goblinName = goblinName;
    this._logger = require('xcraft-core-log')(goblinName, null);
    this._deferrable = [];
    this._ripleyConfig = {};
    this._feed = {};

    const ripleyName = `${this._goblinName}-${this._goblinId}`;

    if (ripleyConfig && goblinConfig.enableCryo) {
      this._ripley = new Ripley('cryo', ripleyName);

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
      ellen: this._ripley
        ? this._ripley.ellen.bind(this._ripley)
        : (s = {}) => s,
      logic: logicReducer,
    });

    const initialState = {
      ellen: this._ripley ? this._ripley.initialState : {},
      logic: new Goblin.Shredder(logicState),
    };

    let composeEnhancers = m => m;
    if (goblinId === 'warehouse' && enableDevTools) {
      const {composeWithDevTools} = require('remote-redux-devtools');
      composeEnhancers = composeWithDevTools({
        name: 'warehouse',
        hostname: 'localhost',
        port: 8123,
      });
    }

    this._store = createStore(
      rootReducer,
      initialState,
      composeEnhancers(
        applyMiddleware(
          this._ripley
            ? this._ripley.persistWith(this._ripleyConfig)
            : emptyMiddleWare,
          questMiddleware(this)
        )
      )
    );

    if (this.useRipley) {
      this._unsubscribeRipley = this._store.subscribe(() => {
        this._logger.verb(`Saving ${this._goblinName} state...`);
        const state = this._store.getState();
        this._ripley.saveState(state.ellen.get(ripleyName));
      });
    }

    watt.wrapAll(this);
    this.upsert = this.upserter;
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

  set feed(feed) {
    this._feed = feed;
  }

  get feed() {
    return this._feed;
  }

  *upserter(quest, payload) {
    if (!this.lastUpsert) {
      this.lastUpsert = payload.data;
      yield quest.warehouse.upsert(payload);
    } else {
      if (!this.lastUpsert.equals(payload.data)) {
        yield quest.warehouse.upsert(payload);
        this.lastUpsert = payload.data;
      }
    }
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

  ///////// ║ ┼ Do quest! ┼ ║ ////////
  /// Welcome to the source core, dear goblin explorator!
  ///
  doQuest(questName, msg, resp, createMutex) {
    return watt(function*(quest, next) {
      verifyMessage(msg);
      injectMessageDataGetter(msg);

      this.prototype = new Quest(resp, msg);
      this.prototype.constructor = watt;

      //////////////////////////////////////////////////////////////////
      ///State save/load
      ///Ripley purpose... not documented, not used for the moment...
      quest.loadState = watt(function*(next) {
        quest.log.verb('Loading state...');
        if (this.useRipley) {
          quest.log.verb('Ripleying...');
          yield this._ripley.ripley(
            this._store,
            quest.getSession(),
            resp.log,
            next
          );
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
        // Handle special quest runner private quest.do case
        if (questName.startsWith('_$')) {
          return this._do(questName.replace('_$', ''), action);
        } else {
          return this._do(questName, action);
        }
      };
      const realDispatch = quest.dispatch;
      quest.dispatch = (...args) => {
        questHasDispatched = true;
        realDispatch(...args);
      };

      quest.log.verb('Starting quest...');

      let result = null;
      let errThrown = false;
      let canceled = false;
      try {
        this.getState().attachLogger(resp.log);

        const createdBy = msg.data ? msg.data.createdBy : null;
        const isSingleton = this.goblinName === this._goblinId;

        if (
          questName === 'create' /* First instance quest */ ||
          questName === 'boot' /* Main app singletons quest */ ||
          questName === 'init' /* First singleton quest */
        ) {
          const payload = {
            branch: this._goblinId,
            data: {},
          };

          payload.createdBy = createdBy || this._goblinId;
          /* It can leak in the warehouse if the real upsert or the delete
           * are never called. For example if the process crashes.
           * TODO: think about a way to remove properly garbage after a
           *       crash.
           */
          yield quest.warehouse.upsert(payload);
        }

        result = yield QUESTS[this._goblinName][questName](quest, msg);

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
          // hide private branch of state
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
                `Your forgot to call quest.do() in create quest of ${
                  this.goblinName
                }`
              );
            }
          }

          if (questHasDispatched) {
            this.upsert(quest, payload);
          }
        }
      } catch (ex) {
        errThrown = true;
        const err = ex.stack || ex;
        resp.events.send(`${this.goblinName}.${questName}.${msg.id}.error`, {
          code: ex.code,
          message: ex.message,
          stack: ex.stack,
        });
        quest.log.err(`quest [${questName}] failure: ${err.message || err}`);
        if (err.stack) {
          quest.log.err(`stack: ${err.stack}`);
        }
        quest.fail(
          `Erreur dans la quête "${questName}"`,
          err,
          'voir ex.',
          err.stack || err.message || err
        );
      } finally {
        quest.log.verb('Ending quest...');

        this.getState().detachLogger();
        //QUEST DEFER SCOPED
        while (quest._deferrable.length > 0) {
          quest._deferrable.pop()();
        }

        if (!errThrown) {
          //Finally, notify others that a new goblin is born
          if (questName === 'create' && !canceled) {
            resp.events.send(`${this._goblinId}.created`, {
              id: this._goblinId,
            });
            for (const feed in this.feed) {
              resp.events.send(`goblin.${feed}.created`, {
                id: this._goblinId,
              });
            }
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
          try {
            resp.events.send(
              `${this.goblinName}.${questName}.${msg.id}.finished`,
              result
            );
          } catch (ex) {
            resp.events.send(
              `${this.goblinName}.${questName}.${msg.id}.error`,
              {
                code: ex.code,
                message: ex.message,
                stack: ex.stack,
              }
            );
            errThrown = true;
          }
        }

        if (questName === 'create' && (errThrown || canceled)) {
          /* If an error occurs while the goblin is created, then we must
           * delete its instance.
           */
          yield quest.warehouse.deleteBranch({
            branch: this._goblinId,
          });
          yield resp.command.send(
            `${this.goblinName}.delete`,
            {
              id: this._goblinId,
              _goblinLegacy: true,
              _goblinMutexRecursive: true,
            },
            next
          );
        }

        if (createMutex && createMutex[this._goblinId]) {
          delete createMutex[this._goblinId];
        }
      }
    });
  }
}

if (enableDevTools) {
  const Daemon = require('xcraft-core-daemon');
  const remotedev = new Daemon(
    'remotedev',
    path.join(__dirname, 'remotedev.js'),
    {
      bin: 'node',
      detached: false,
    },
    true
  );
  remotedev.start();
  process.on('exit', () => remotedev.stop());
}

module.exports = Goblin;
module.exports.Shredder = Shredder;
