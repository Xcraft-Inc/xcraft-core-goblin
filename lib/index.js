'use strict';

const path = require('path');
const watt = require('gigawatts');
const uuidV4 = require('uuid/v4');
const {createStore, combineReducers, applyMiddleware} = require('redux');
const Shredder = require('xcraft-core-shredder');
const xUtils = require('xcraft-core-utils');
const coreGoblinConfig = require('xcraft-core-etc')().load(
  'xcraft-core-goblin'
);
const Ripley = require('./ripley.js');

const {isGenerator, isFunction} = xUtils.js;
const {RankedCache} = xUtils;

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

let foregroundParallelQuests = 0;
let backgroundParallelQuests = 0;

const doAsyncQuest = watt(function*(quest, dispatch, goblin, scheduled) {
  const questDispatcher = function(type, payload = {}, error = false) {
    const action = createAction(type, payload, error);
    dispatch(action);
  };

  if (scheduled) {
    try {
      backgroundParallelQuests++;
      yield quest({dispatch: questDispatcher, goblin});
    } finally {
      backgroundParallelQuests--;
    }
  } else {
    switch (goblin.schedulingMode) {
      default:
      case 'foreground':
        try {
          foregroundParallelQuests++;
          yield quest({dispatch: questDispatcher, goblin});
        } finally {
          foregroundParallelQuests--;
        }

        break;
      case 'background':
        // setTimeout(() => doAsyncQuest(quest, dispatch, goblin, true, next), 1);
        yield doAsyncQuest(quest, dispatch, goblin, true);
        break;
    }
  }
});

const questMiddleware = goblin => store => next => action => {
  return isFunction(action)
    ? doAsyncQuest(action, store.dispatch, goblin, false)
    : next(action);
};

const emptyMiddleWare = (/* store */) => next => action => next(action);

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

// Ranked cache
const RANKEDCACHE = {};

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
        resp.log.info(`=================================`);
        resp.log.info(`=== Goblins                   ===`);
        resp.log.info(`=================================`);
        Object.keys(GOBLINS)
          .sort()
          .forEach(name => {
            resp.log.info(`${name}:`);
            if (GOBLINS[name]) {
              Object.keys(GOBLINS[name]).forEach(gob => {
                resp.log.info(`  ${gob}`);
              });
            }
          });

        resp.log.info('');
        resp.log.info(`=================================`);
        resp.log.info(`=== Sessions                  ===`);
        resp.log.info(`=================================`);
        Object.keys(SESSIONS)
          .filter(name => SESSIONS[name] && Object.keys(SESSIONS[name]).length)
          .sort()
          .forEach(name => {
            resp.log.info(`${name}:`);
            Object.keys(SESSIONS[name]).forEach(id => {
              resp.log.info(`  ${id}`);
              Object.keys(SESSIONS[name][id]).forEach(session => {
                resp.log.info(`    ${session}`);
              });
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

    const goblinMutex = {};

    const updateFeeds = (goblin, msg) => {
      const feed = msg.data && msg.data._goblinFeed;
      if (feed) {
        Object.assign(goblin.feed, feed);
      }
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

            /* Already creating or deleting, retry later */
            if (goblinMutex[id]) {
              setTimeout(() => resp.command.retry(msg), 20);
              return;
            }

            /* Acquire immediatly the mutex, we must test if this instance
             * already exists.
             */
            goblinMutex[id] = true;

            let goblin =
              GOBLINS[goblinName] && GOBLINS[goblinName][msg.data.id];

            const TTL =
              goblin && goblin._rankItem && goblin._rankItem.list
                ? 'Infinity'
                : msg.data._goblinTTL > 0
                ? msg.data._goblinTTL
                : goblin
                ? goblin.TTL
                : 0;

            const existRes = yield resp.command.send(
              `warehouse.update-created-by`,
              {
                branch: id,
                createdBy: msg.data.createdBy,
                TTL,
              },
              next
            );

            // Hum?
            // goblin instance must exist or
            // not while the branch exist in the warehouse ?

            /* The goblin and the state exist, go out ... */
            if (goblin && existRes.data === true) {
              if (!msg.data.createdBy) {
                throw new Error('Cannot create...');
              }

              goblin.TTL = TTL;
              updateFeeds(goblin, msg);

              for (const feedId in goblin.feed) {
                resp.events.send(`goblin.${feedId}.created`, {id});
              }
              resp.events.send(`${id}.created`, {id});
              resp.events.send(`${goblinName}.create.${msg.id}.finished`, id);

              delete goblinMutex[id]; /* Release for the next */
              return;
            }

            /* The goblin exists but the state is still not upserted,
             * retry later...
             */
            if (goblin) {
              setTimeout(() => resp.command.retry(msg), 20);
              delete goblinMutex[id]; /* Release for the next */
              return;
            }

            goblin = Goblin.create(goblinName, id);
            goblin.TTL = TTL;
            updateFeeds(goblin, msg);

            goblin.dispatch(
              goblin.doQuest(questName, msg, resp, goblinMutex).bind(goblin)
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
        if (!msg.data._goblinMutexRecursive && goblinMutex[msg.data.id]) {
          setTimeout(() => resp.command.retry(msg), 20);
          return false;
        }

        goblinMutex[msg.data.id] = true;
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
            goblin.doQuest(questName, msg, resp, goblinMutex).bind(goblin)
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

  static getGoblinRegistry() {
    return GOBLINS;
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
   * @param {Object} goblinConfig
   */
  static configure(goblinName, logicState, logicHandlers, goblinConfig) {
    if (!CONFIGS[goblinName]) {
      CONFIGS[goblinName] = {};
    }

    if (!SESSIONS[goblinName]) {
      SESSIONS[goblinName] = {};
    }

    CONFIGS[goblinName] = {
      logicState,
      logicHandlers,
      goblinConfig,
    };

    if (!GOBLINS[goblinName]) {
      GOBLINS[goblinName] = {};
    }

    if (!RANKEDCACHE[goblinName] && goblinConfig && goblinConfig.cacheSize) {
      RANKEDCACHE[goblinName] = new RankedCache(goblinConfig.cacheSize);
      RANKEDCACHE[goblinName].on('out', item => {
        const branch = item.payload.goblinId;
        if (!GOBLINS[goblinName][branch]) {
          return;
        }
        const TTL = GOBLINS[goblinName][branch].TTL;
        const busClient = require('xcraft-core-busclient').getGlobal();
        busClient.command.send('warehouse.update-created-by', {branch, TTL});
      });
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
      CONFIGS[goblinName].goblinConfig
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
      CONFIGS[goblinName].goblinConfig
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

  constructor(goblinId, goblinName, logicState, logicHandlers, goblinConfig) {
    this._goblinId = goblinId;
    this._goblinName = goblinName;
    this._logger = require('xcraft-core-log')(goblinName, null);
    this._deferrable = [];
    this._goblinConfig = goblinConfig || {};

    this._feed = {};
    this._TTL = 0;
    this.schedulingMode = this._goblinConfig.schedulingMode || 'foreground';

    const ripleyName = `${this._goblinName}-${this._goblinId}`;
    if (this._goblinConfig.ripley && coreGoblinConfig.enableCryo) {
      this._ripley = new Ripley('cryo', ripleyName);
    }

    if (this._goblinConfig.ripley) {
      for (const k in this._goblinConfig.ripley) {
        this._goblinConfig.ripley[k].db = ripleyName;

        if (!('mode' in this._goblinConfig.ripley[k])) {
          throw new Error(`Bad goblin ripley config, missing for ${k}`);
        }

        if (this._ripley) {
          if (!this._ripley.hasMode(this._goblinConfig.ripley[k].mode)) {
            throw new Error(`Bad goblin ripley config, unknow mode for ${k}`);
          }
        }
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
            ? this._ripley.persistWith(this._goblinConfig.ripley)
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

    watt.wrapAll(this, 'upserter');
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
    if (!this._ripley) {
      return false;
    }
    return Object.keys(this._goblinConfig.ripley).length > 0;
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

  set TTL(TTL) {
    this._TTL = TTL;
  }

  get TTL() {
    return this._TTL;
  }

  *upserter(quest, payload) {
    payload._upsertQuest = quest.questName;
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

  getX(key, fallback) {
    if (!SESSIONS[this.goblinName][this.id]) {
      return null;
    }
    if (fallback && !SESSIONS[this.goblinName][this.id].hasOwnProperty(key)) {
      SESSIONS[this.goblinName][this.id][key] = fallback;
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
  doQuest(questName, msg, resp, goblinMutex) {
    const Quest = require('./quest.js');
    return watt(function*(context, next) {
      const quest = new Quest(context, questName, msg, resp);

      verifyMessage(msg);
      injectMessageDataGetter(msg);

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

          if (!isSingleton) {
            payload.isCreating = true;
          }

          payload.createdBy = createdBy || this._goblinId;

          if (
            this.TTL === 0 &&
            this._goblinConfig &&
            this._goblinConfig.cacheSize > 0
          ) {
            this._rankItem = RANKEDCACHE[this._goblinName].rank({
              goblinId: this._goblinId,
            });
            payload.TTL = 'Infinity';
          } else if (this.TLL > 0) {
            payload.TTL = this.TTL;
          }

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
            if (!isSingleton) {
              payload.isCreating = false;
            }
            payload.createdBy = createdBy || this._goblinId;
            if (!quest.hasDispatched && !isSingleton) {
              throw new Error(
                `Your forgot to call quest.do() in create quest of ${
                  this.goblinName
                }`
              );
            }
          }

          if (quest.hasDispatched) {
            if (this.TTL === 0 && this._rankItem) {
              RANKEDCACHE[this._goblinName].rank(this._rankItem);
              payload.TTL = 'Infinity';
            } else if (this.TTL > 0) {
              payload.TLL = this.TTL;
            }

            yield this.upsert(quest, payload);
          } else if (payload.hasOwnProperty('isCreating')) {
            yield quest.warehouse.removeCreatedBy({
              branch: this._goblinId,
              owners: ['new'],
            });
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
            for (const feed in this.feed) {
              resp.events.send(`goblin.${feed}.created`, {id: this._goblinId});
            }
            resp.events.send(`${this._goblinId}.created`, {id: this._goblinId});
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
            resp.events.send(`${this._goblinId}.deleted`, {
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

        if (
          (questName === 'create' || questName === 'delete') &&
          goblinMutex &&
          goblinMutex[this._goblinId]
        ) {
          delete goblinMutex[this._goblinId];
        }
      }
    });
  }
}

if (enableDevTools) {
  const Daemon = require('xcraft-core-daemon');
  const xcraftDebug = process.env.XCRAFT_DEBUG;
  process.env.XCRAFT_DEBUG = '0';
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
  process.env.XCRAFT_DEBUG = xcraftDebug;
  process.on('exit', () => remotedev.stop());
}

module.exports = Goblin;
module.exports.Shredder = Shredder;
