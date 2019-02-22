'use strict';

const path = require('path');
const watt = require('gigawatts');
const uuidV4 = require('uuid/v4');
const $ = require('highland');
const {createStore, combineReducers, applyMiddleware} = require('redux');
const Shredder = require('xcraft-core-shredder');
const xUtils = require('xcraft-core-utils');
const coreGoblinConfig = require('xcraft-core-etc')().load(
  'xcraft-core-goblin'
);
const Ripley = require('./ripley.js');

const {isGenerator, isFunction} = xUtils.js;

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
    action.get = (key, fallback) => {
      if (action.payload[key] !== undefined) {
        return action.payload[key];
      }
      if (action.meta[key] !== undefined) {
        return action.meta[key];
      }
      return fallback;
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
          // FIXME: broken, missing `parent` and `feed` properties
          resp.command.send('warehouse.upsert', {
            branch: id,
            data: data,
          });
        }
      }
    }),
  };
}

const EventEmitter = require('events');
const questEmitter = new EventEmitter();
const emitAsyncQuest = (...args) => questEmitter.emit('quest', ...args);

const createQuests = ['create'];
$('quest', questEmitter).each(quest => {
  quest.cmdMode = null;

  if (quest.questName === 'delete') {
    quest.cmdMode = 'delete';
    quest.goblin.questEmitter.emit('dispatch-quest', quest);
    return;
  }

  if (quest.questName === 'create' && quest.isRecreate) {
    quest.cmdMode = 'recreate';
    quest.goblin.questEmitter.emit('dispatch-quest', quest);
    return;
  }

  if (quest.caller === undefined) {
    quest.cmdMode = 'parallel';
    quest.goblin.questEmitter.emit('dispatch-quest', quest);
    return;
  }

  const selfCall = quest.caller === quest.goblin.id;
  const inCreateQuest = createQuests.includes(quest.questName);
  if (
    (quest.goblin.isCreating() && selfCall) ||
    (inCreateQuest && selfCall) ||
    (inCreateQuest && quest.goblin.isCreating()) ||
    (inCreateQuest && quest.isInCreate)
  ) {
    quest.cmdMode = 'create';
  } else {
    quest.cmdMode = 'parallel';
  }

  quest.goblin.questEmitter.emit('dispatch-quest', quest);
});

class Scheduler {
  constructor(goblinName, goblinId, generation) {
    this._goblinName = goblinName;

    this._generationId = generation || uuidV4();

    this.questEmitter = new EventEmitter();
    this._queue = new EventEmitter();

    const serieRunner = $('serie', this._queue)
      .map(({goblin, questName, quest, dispatch, done}) => next => {
        Goblin._questDispatch(goblin, questName, quest, dispatch, done, next);
      })
      .nfcall([])
      .sequence()
      .stopOnError(err => console.warn(err));

    const parallelRunner = $('parallel', this._queue)
      .map(({goblin, questName, quest, dispatch, done}) => next => {
        Goblin._questDispatch(goblin, questName, quest, dispatch, done, next);
      })
      .nfcall([])
      .parallel(Number.MAX_VALUE)
      .stopOnError(err => console.warn(err));

    //Singleton? enable runners
    if (goblinId === goblinName) {
      parallelRunner.done();
      serieRunner.done();
    }

    $('create', this._queue)
      .map(({goblin, questName, quest, dispatch, done}) => next => {
        const _done = () => {
          if (questName === 'create') {
            if (parallelRunner.paused) {
              parallelRunner.done();
            }
            if (serieRunner.paused) {
              serieRunner.done();
            }
          }
          done();
        };
        Goblin._questDispatch(goblin, questName, quest, dispatch, _done, next);
      })
      .nfcall([])
      .parallel(Number.MAX_VALUE)
      .stopOnError(err => console.warn(err))
      .done();

    $('dispatch-quest', this.questEmitter)
      .map(payload => next => this._dispatcher(payload, next))
      .nfcall([])
      .sequence()
      .stopOnError(err => console.warn(err))
      .done();

    this.apiPromises = [];
    this.createPromises = [];

    this.deletePromise = null;

    watt.wrapAll(this, '_dispatcher');
  }

  nextDelete(call) {
    this.deletePromise = new Promise(resolve => call(resolve));
    this.deletePromise.then(() => {
      this.deletePromise = null;
    });
  }

  nextParallel(call, promises) {
    const promise = new Promise(resolve => call(resolve));
    promises.push(promise);
    const index = promises.length - 1;
    promise.then(() => {
      promises.splice(index, 1);
    });
  }

  *_dispatcher({goblin, questName, quest, dispatch, cmdMode, msg, resp}, next) {
    switch (cmdMode) {
      case 'delete':
        if (msg.data.generation !== goblin._generationId) {
          resp.events.send(`${this._goblinName}.delete.${msg.id}.finished`);
          return;
        }

        yield Promise.all(this.createPromises);
        this.createPromises = [];
        yield Promise.all(this.apiPromises);
        this.apiPromises = [];

        this.nextDelete(done =>
          Goblin._questDispatch(
            goblin,
            questName,
            quest,
            dispatch,
            done,
            next.parallel()
          )
        );
        yield next.sync();
        break;

      case 'recreate':
        if (this.deletePromise) {
          yield this.deletePromise;
          /* and fallthrough the create case */
        } else {
          const toUpsert = goblin.getState().state.delete('private');

          /* First create already creating, go out (break) */
          if (toUpsert.size === 0 && goblin._runningQuests.create >= 2) {
            resp.events.send(
              `${this._goblinName}.create.${msg.id}.finished`,
              goblin.id
            );
            break;
          }

          /* Upsert again and go out (break) */
          if (toUpsert.size > 0) {
            const payload = {
              branch: goblin.id,
              data: toUpsert,
              parents: msg.data.parent,
              feeds:
                (msg.data &&
                  msg.data._goblinFeed &&
                  Object.keys(msg.data._goblinFeed)) ||
                null,
            };
            yield resp.command.send(`warehouse.upsert`, payload, next);

            resp.events.send(
              `${this._goblinName}.create.${msg.id}.finished`,
              goblin.id
            );
            break;
          }

          /* FIXME: it should never happend? Then create fully again.
           *        Maybe it's just because the deletePromise was just
           *        resolved after the recreate detection?! Why not..
           *        If it's the reason, then it's right to fallthrough.
           */
          if (toUpsert.size === 0) {
            console.warn(
              `Empty state when recreating ${goblin.id}, 'create' fallthrough`
            );
          }

          /* fallthrough ... break is not missing here*/
        }

      /* eslint no-fallthrough: "error" */
      case 'create':
        /* create commands and commands called from create */
        if (questName === 'create') {
          this.nextParallel(
            done =>
              this._queue.emit('create', {
                goblin,
                questName,
                quest,
                dispatch,
                done,
              }),
            this.createPromises
          );
        } else {
          this.nextParallel(
            done =>
              this._queue.emit('create', {
                goblin,
                questName,
                quest,
                dispatch,
                done,
              }),
            this.apiPromises
          );
        }
        break;

      case 'serie':
        this.nextParallel(
          done =>
            this._queue.emit('serie', {
              goblin,
              questName,
              quest,
              dispatch,
              done,
            }),
          this.apiPromises
        );
        break;

      case 'parallel':
        this.nextParallel(
          done =>
            this._queue.emit('parallel', {
              goblin,
              questName,
              quest,
              dispatch,
              done,
            }),
          this.apiPromises
        );
        break;
    }
  }
}

const questMiddleware = goblin => store => next => action => {
  return action.type === 'DOASYNCQUEST'
    ? emitAsyncQuest({
        quest: action.quest,
        dispatch: store.dispatch,
        questName: action.questName,
        caller: action.caller,
        callerQuest: action.callerQuest,
        isInCreate: action.isInCreate,
        isRecreate: action.isRecreate,
        msg: action.msg,
        resp: action.resp,
        goblin,
        schedulingMode: false,
      })
    : next(action);
};

const emptyMiddleWare = (/* store */) => next => action => next(action);

function injectMessageDataGetter(msg) {
  msg.get = (key, fallback = null) => {
    if (msg.data) {
      if (Shredder.isImmutable(msg.data[key])) {
        return new Shredder(msg.data[key]);
      }
      return msg.data[key];
    }
    return fallback;
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

class Goblin {
  static registerQuest(goblinName, questName, quest, subs) {
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

    /* configure global subscriptions */
    QUESTSMETA[goblinName][questName].subs = subs || [];

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
          if (!msg.data) {
            msg.data = {
              _goblinCaller: 'core-host',
              _goblinCallerQuest: 'bigbang',
              _goblinInCreate: false,
            };
          }
          try {
            injectMessageDataGetter(msg);
            const id = msg.get('id') || `${goblinName}@${uuidV4()}`;
            const generation = uuidV4();
            if (id.indexOf('@') === -1) {
              throw new Error(
                `Bad goblin id provided during ${goblinName}.create, id must respect this format:
              (meta@)name@unique-identifier`
              );
            }

            if (!msg.data._goblinCaller || !msg.data._goblinCallerQuest) {
              throw new Error('Malformed create, missing payload');
            }

            let goblin =
              GOBLINS[goblinName] && GOBLINS[goblinName][msg.data.id];

            const TTL =
              msg.data._goblinTTL > 0
                ? msg.data._goblinTTL
                : goblin
                ? goblin.TTL
                : 0;

            yield resp.command.send(
              `warehouse.attach-to-parents`,
              {
                branch: id,
                generation,
                parents: msg.data.parent,
                feeds:
                  (msg.data &&
                    msg.data._goblinFeed &&
                    Object.keys(msg.data._goblinFeed)) ||
                  null,
              },
              next
            );

            if (goblin) {
              //console.log('RECREATE ', id);
              msg.data._goblinRecreate = true;
            } //else {
            //console.log('CREATE ', id);
            //}
            goblin = Goblin.create(goblinName, id, generation);
            goblin.TTL = TTL;
            updateFeeds(goblin, msg);
            const asyncQuestAction = {
              type: 'DOASYNCQUEST',
              caller: msg.data._goblinCaller,
              callerQuest: msg.data._goblinCallerQuest,
              isInCreate: msg.data._goblinInCreate,
              isRecreate: !!msg.data._goblinRecreate,
              msg: msg,
              resp,
              questName,
              quest: goblin.doQuest(questName, msg, resp).bind(goblin),
            };
            goblin.store.dispatch(asyncQuestAction);
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

      quests[questName] = (msg, resp) => {
        if (!msg.data) {
          msg.data = {};
        }

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

            const asyncQuestAction = {
              type: 'DOASYNCQUEST',
              questName,
              caller: msg.data._goblinCaller,
              callerQuest: msg.data._goblinCallerQuest,
              isInCreate: msg.data._goblinInCreate,
              isRecreate: false,
              msg: msg,
              resp,
              quest: goblin.doQuest(questName, msg, resp).bind(goblin),
            };
            goblin.store.dispatch(asyncQuestAction);
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
            let from = '';
            if (msg.data) {
              from = `from ${msg.data._goblinCaller}.${
                msg.data._goblinCallerQuest
              }`;
            }
            throw new Error(
              `Error calling quest ${goblinName}.${questName} ${from}: goblin with id ${
                msg.data.id
              } has not been created`
            );
          }

          const asyncQuestAction = {
            type: 'DOASYNCQUEST',
            questName,
            caller: msg.data._goblinCaller,
            callerQuest: msg.data._goblinCallerQuest,
            isInCreate: msg.data._goblinInCreate,
            isRecreate: false,
            msg: msg,
            resp,
            quest: goblin.doQuest(questName, msg, resp).bind(goblin),
          };
          goblin.store.dispatch(asyncQuestAction);
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

  static getGoblinsRegistry() {
    return GOBLINS;
  }

  static getSessionsRegistry() {
    return SESSIONS;
  }

  static getRC(goblinName) {
    const rc = {};

    Object.keys(QUESTS[goblinName]).forEach(questName => {
      const params = {};
      const desc = !questName.startsWith('_')
        ? `${questName} for ${goblinName}`
        : null;

      const delayed = false;

      const list = QUESTSMETA[goblinName][questName].params;
      params.required = list.filter(v => v[0] !== '$');
      params.optional = list.filter(v => v[0] === '$');

      const subs = QUESTSMETA[goblinName][questName].subs;

      rc[questName] = {
        parallel: true,
        delayed,
        desc,
        options: {
          params,
          subs,
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

    return {
      handlers: Goblin.getQuests(goblinName),
      context: getContextManager(),
      rc: Goblin.getRC(goblinName),
    };
  }

  static create(goblinName, uniqueIdentifier, generation) {
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
      GOBLINS[goblinName][goblinId]._generationId = generation;
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
      CONFIGS[goblinName].goblinConfig,
      generation
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
    GOBLINS[goblinName][goblinId].TTL = 0;
    delete GOBLINS[goblinName][goblinId];
    delete SESSIONS[goblinName][goblinId];
  }

  _do(questName, payload = {}, error = false) {
    if (!this._logicHasType(questName)) {
      throw new Error(`Cannot do (${questName}), missing logic handler`);
    }
    this.dispatch(questName, payload, error);
  }

  static _questDispatch(goblin, questName, quest, dispatch, done, next) {
    const questDispatcher = function(type, payload = {}, error = false) {
      const action = createAction(type, payload, error);
      dispatch(action);
    };
    goblin.running(questName, true);
    quest({dispatch: questDispatcher, goblin}, err => {
      goblin.running(questName, false);
      if (done) {
        done();
      }
      next(err);
    });
  }

  constructor(
    goblinId,
    goblinName,
    logicState,
    logicHandlers,
    goblinConfig,
    generation
  ) {
    this._scheduler = new Scheduler(goblinName, goblinId, generation);
    this.questEmitter = this._scheduler.questEmitter;

    this._goblinId = goblinId;
    this._goblinName = goblinName;
    this._logger = require('xcraft-core-log')(goblinName, null);
    this._deferrable = [];
    this._goblinConfig = Object.assign({}, goblinConfig || {});

    this._runningQuests = {};
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
    const usesTTL = this._TTL > 0 || TTL > 0;
    this._TTL = TTL;
    if (usesTTL) {
      const Cache = require('./cache/index.js');
      Cache.update(this.id, TTL);
    }
  }

  get TTL() {
    return this._TTL;
  }

  isCreating() {
    if (this.goblinName === this._goblinId) {
      return false;
    }
    return this._runningQuests.create && this._runningQuests.create > 0;
  }

  isDeleting() {
    if (this.goblinName === this._goblinId) {
      return false;
    }
    return this._runningQuests.delete && this._runningQuests.delete > 0;
  }

  isRunning() {
    return Object.values(this._runningQuests).some(count => count > 0);
  }

  running(questName, running) {
    if (!this._runningQuests[questName]) {
      this._runningQuests[questName] = 0;
    }
    this._runningQuests[questName] = running
      ? this._runningQuests[questName] + 1
      : this._runningQuests[questName] - 1;
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
  doQuest(questName, msg, resp) {
    const Quest = require('./quest.js');
    const Cache = require('./cache/index.js');

    return watt(function*(context, next) {
      const quest = new Quest(context, questName, msg, resp);

      verifyMessage(msg);
      injectMessageDataGetter(msg);

      quest.log.verb('Starting quest...');

      const isSingleton = this.goblinName === this._goblinId;
      let isCreating = null;

      let result = null;
      let errThrown = false;
      let canceled = false;
      try {
        this.getState().attachLogger(resp.log);

        let isRanked = false;
        const parent = msg.data ? msg.data.parent : null;

        if (
          questName === 'create' /* First instance quest */ ||
          questName === 'boot' /* Main app singletons quest */ ||
          questName === 'init' /* First singleton quest */
        ) {
          const payload = {
            branch: this._goblinId,
            generation: this._generationId,
            data: {},
            feeds:
              (msg.data &&
                msg.data._goblinFeed &&
                Object.keys(msg.data._goblinFeed)) ||
              'system',
          };

          if (!isSingleton) {
            isCreating = true;
            payload.isCreating = isCreating;
            payload.creator = msg.data._goblinCaller;
          }

          payload.parents = parent || this._goblinId;

          /* It can leak in the warehouse if the real upsert or the delete
           * are never called. For example if the process crashes.
           * TODO: think about a way to remove properly garbage after a
           *       crash.
           */
          yield quest.warehouse.upsert(payload);

          if (
            this.TTL === 0 &&
            this._goblinConfig &&
            this._goblinConfig.cacheSize > 0
          ) {
            yield Cache.rank(
              this._goblinName,
              this._goblinId,
              this._goblinConfig.cacheSize
            );
            isRanked = true;
          }
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
          if (questName === 'create' && !parent && !isSingleton) {
            throw new Error(
              `Fatal error ${msg.topic} missing 'parent' parameter`
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
            feeds: Object.keys(this.feed),
          };

          if (questName === 'create' || isSingleton) {
            payload.parents = parent || this._goblinId;
            if (!quest.hasDispatched && !isSingleton) {
              throw new Error(
                `Your forgot to call quest.do() in create quest of ${
                  this.goblinName
                }`
              );
            }
          }

          if (quest.hasDispatched) {
            if (
              !isRanked &&
              this.TTL === 0 &&
              this._goblinConfig &&
              this._goblinConfig.cacheSize > 0
            ) {
              yield Cache.rank(this._goblinName, this._goblinId);
            }

            yield this.upsert(quest, payload);
          }
        }
      } catch (ex) {
        errThrown = ex;
      } finally {
        quest.log.verb('Ending quest...');

        this.getState().detachLogger();
        //QUEST DEFER SCOPED
        try {
          while (quest._deferrable.length > 0) {
            quest._deferrable.pop()();
          }
        } catch (ex) {
          quest.log.err(
            `quest.defer failed for ${
              this._goblinId
            }/${questName}: ${ex.stack || ex}`
          );
        }

        if (!errThrown) {
          if (questName === 'delete' && !canceled) {
            //GOBLIN DELETE QUEST DEFER SCOPED
            try {
              while (this._deferrable.length > 0) {
                this._deferrable.pop()();
              }
            } catch (ex) {
              quest.log.err(
                `quest.goblin.defer failed for ${
                  this._goblinId
                }/${questName}: ${ex.stack || ex}`
              );
            }

            if (this.useRipley) {
              this._unsubscribeRipley();
            }

            Goblin.release(this.goblinName, this._goblinId);
            resp.events.send(`${this._goblinId}.deleted`, {
              id: this._goblinId,
            });
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
            },
            next
          );
        } else if (isCreating === true) {
          yield quest.warehouse.delCreator({
            branch: this._goblinId,
          });
        }

        if (!errThrown) {
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
            errThrown = ex;
          }
        }

        if (errThrown) {
          const ex = errThrown;
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
