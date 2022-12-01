'use strict';
///////////////////////////////////////////////////////////////////////////////
// WARNING ABOUT GOBLINS:
//
// They employ vast teams of engineers who expand on current technology and
// produce gadgets to suit a wide array of applications.
//
// They constantly build and repair machines and work on new ideas.
// Unfortunately, goblins alternate passionate genius with wandering focus.
//
// Their lack of discipline means that many creations
// end up half finished as something else catches their attention.
//
// Goblin workmanship has a partially deserved reputation for unreliability,
// and a goblin device may explode simply because
// its creator forgot(or couldn't be bothered) to add a vital release valve.
//
///////////////////////////////////////////////////////////////////////////////

const watt = require('gigawatts');
const {v4: uuidV4} = require('uuid');
const cloneDeep = require('lodash/cloneDeep');
const {createStore, combineReducers, applyMiddleware} = require('redux');
const Shredder = require('xcraft-core-shredder');
const SmartId = require('./smartId');
const {js, reflect} = require('xcraft-core-utils');
const {isAsync, isGenerator, isFunction} = js;
const coreGoblinConfig = require('xcraft-core-etc')().load(
  'xcraft-core-goblin'
);
const busConfig = require('xcraft-core-etc')().load('xcraft-core-bus');
const appBuilder = require('./appBuilder.js');
const workerBuilder = require('./workerBuilder.js');
const queueBuilder = require('./queueBuilder.js');
const Ripley = require('./ripley.js');
const Scheduler = require('./scheduler.js');
const guildEnforcer = require('./guildEnforcer.js')(busConfig);
const osInfo = require('./osInfo.js');

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
    get: (name) => {
      const states = {};
      const ids = [];
      let single = false;
      GOBLINS.get(name).forEach((gob, k) => {
        if (k === name) {
          single = true;
        }
        ids.push(k);
        states[k] = gob.store.getState();
      });
      //TODO: Call delete
      return {
        states,
        ids,
        isSingle: single && GOBLINS.get(name).size === 1,
        sessions: SESSIONS.get(name) || {},
      };
    },
    set: watt(function* (name, context, resp, next) {
      for (const id of context.ids) {
        yield resp.command.send(`${name}.create`, {id}, next);
        SESSIONS.get(name).set(id, context.sessions.get(id));
        const goblin = GOBLINS.get(name).get(id);
        const state = context.states[id];
        goblin.store.dispatch({
          type: '@@RELOAD_STATE',
          state: state.logic,
        });

        if (name !== 'warehouse') {
          const data = goblin.getState().state;
          // FIXME: broken, missing `parent` and `feed` properties
          resp.command.send(
            'warehouse.upsert',
            {
              branch: id,
              data: data,
            },
            next
          );
        }
      }
    }),
  };
}

const emitAsyncQuest = (...args) => Scheduler.dispatch('quest', ...args);

const questMiddleware = (goblin) => (store) => (next) => (action) => {
  if (action.type === 'DOASYNCQUEST') {
    try {
      const cmd = action.msg.topic;
      //TODO: Fail securely
      const isBlocked = guildEnforcer.isBlocked;
      if (isBlocked(goblin, cmd)) {
        throw new Goblin.ShieldedError(
          `Blocked by a shield: the goblin ${goblin.id} is not allowed to run ${cmd}`
        );
      }
      const user = Goblin.identifyUser(action.msg);
      if (isBlocked(user, cmd)) {
        throw new Goblin.ShieldedError(
          `Blocked by a shield: the user ${
            user.login || 'unknown'
          } with the rank ${
            user.rank || 'unknown'
          } is not allowed to run ${cmd}`
        );
      }
      return emitAsyncQuest({
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
      });
    } catch (ex) {
      action.resp.events.send(
        `${goblin.goblinName}.${action.questName}.${action.msg.id}.error`,
        {
          code: ex.code,
          message: ex.message,
          stack: ex.stack,
        }
      );
    }
  }
  return next(action);
};

const emptyMiddleWare = (/* store */) => (next) => (action) => next(action);

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

const QUESTSHANDLES = {};

// Goblins registry
const GOBLINS = new Map();

// Goblins sessions
const SESSIONS = new Map();

// Configs registry
const CONFIGS = {};

let GENERATION = 0;

class Goblin {
  static buildApplication(appId, config) {
    return appBuilder(appId, config);
  }

  static buildQueue(queueName, config) {
    return queueBuilder(queueName, config);
  }

  static buildQueueWorker(queueName, config) {
    return workerBuilder(queueName, config);
  }

  //Batch register
  static registerQuests(goblinName, quests, options, safe = false) {
    let Call = Goblin.registerQuest;
    if (safe) {
      Call = Goblin.registerSafeQuest;
    }
    if (quests) {
      Object.keys(quests).forEach((q) => {
        if (options && options[q]) {
          Call(goblinName, q, quests[q], options[q]);
        } else {
          Call(goblinName, q, quests[q]);
        }
      });
    }
  }

  //Little wrapper with overhead around registerQuest
  static registerSafeQuest(goblinName, questName, questFunc, options) {
    Goblin.registerQuest(
      goblinName,
      questName,
      function* (quest, $msg, next) {
        const params = reflect
          .funcParams(questFunc)
          .filter((param) => !/^(quest|next)$/.test(param));
        const questArguments = params.map((p) => $msg.get(p));

        try {
          yield quest.sysCreate();
          if (js.isGenerator(questFunc)) {
            return yield* questFunc(quest, ...questArguments, next);
          } else if (js.isAsync(questFunc)) {
            return yield questFunc(quest, ...questArguments);
          } else {
            return questFunc(quest, ...questArguments, next);
          }
        } finally {
          yield quest.sysKill();
        }
      },
      options
    );
  }

  static registerQuest(goblinName, questName, quest, options) {
    if (!QUESTSMETA[goblinName]) {
      QUESTSMETA[goblinName] = {};
    }

    const xUtils = require('xcraft-core-utils');
    if (!QUESTSMETA[goblinName][questName]) {
      QUESTSMETA[goblinName][questName] = {};
    }
    QUESTSMETA[goblinName][questName].options = options || {};
    const opt = QUESTSMETA[goblinName][questName].options;
    //GUILD: better init
    const RUN_QUEST = Symbol.for('RUN_QUEST');
    if (opt.skills) {
      for (const skill of opt.skills) {
        if (typeof skill !== 'symbol') {
          throw new Error(`Invalid skill provided for ${goblinName}`);
        }
      }
      opt.skills.push(RUN_QUEST);
    } else {
      opt.skills = [RUN_QUEST];
    }
    QUESTSMETA[goblinName][questName].params = xUtils.reflect
      .funcParams(quest)
      .filter((param) => !/^(quest|next)$/.test(param));

    QUESTSHANDLES[`${goblinName}/${questName}`] = quest;

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

      return QUESTSHANDLES[`${goblinName}/${questName}`](...args);
    };

    if (!QUESTS[goblinName]) {
      QUESTS[goblinName] = {};
    }
    if (!isGenerator(quest) && !isAsync(quest)) {
      /* eslint require-yield: 0 */
      QUESTS[goblinName][questName] = watt(function* (q, msg) {
        return _quest(q, msg);
      });
      return;
    }
    if (isAsync(quest)) {
      QUESTS[goblinName][questName] = _quest;
      return;
    }
    QUESTS[goblinName][questName] = watt(_quest);
  }

  static getQuests(goblinName) {
    const quests = {};

    Object.keys(QUESTS[goblinName]).forEach((questName) => {
      //Handle create
      if (questName === 'create') {
        quests[questName] = watt(function* (msg, resp, next) {
          if (!msg.data) {
            msg.data = {
              _goblinCaller: 'core-host',
              _goblinCallerQuest: 'bigbang',
              _goblinInCreate: false,
            };
          }
          let id;
          try {
            injectMessageDataGetter(msg);
            id = msg.get('id') || `${goblinName}@${uuidV4()}`;
            const generation = Goblin.nextGen();
            if (id.indexOf('@') === -1) {
              throw new Error(
                `Bad goblin id provided during ${goblinName}.create, id must respect this format: (meta@)name@unique-identifier`
              );
            }

            if (!msg.data._goblinCaller || !msg.data._goblinCallerQuest) {
              throw new Error('Malformed create, missing payload');
            }

            let goblin =
              GOBLINS.has(goblinName) &&
              GOBLINS.get(goblinName).get(msg.data.id);

            const TTL =
              msg.data._goblinTTL > 0
                ? msg.data._goblinTTL
                : goblin
                ? goblin.TTL
                : 0;

            if (goblin) {
              msg.data._goblinRecreate = true;
            }

            goblin = Goblin.create(goblinName, id, generation);
            goblin.TTL = TTL;
            if (!goblin.feed && !msg.data._goblinRecreate) {
              goblin.feed =
                msg.data && msg.data.desktopId && msg.data.desktopId;
            }

            const {data: isAttached} = yield resp.command.nestedSend(
              `warehouse.attach-to-parents`,
              {
                branch: id,
                generation,
                parents: msg.data.parent,
                feeds: (msg.data && msg.data.desktopId) || null,
                view: msg.data?._goblinView || null,
              },
              next
            );
            if (!isAttached) {
              throw {
                code: 'SILENT_HILL',
                message: `attach impossible (parent ${msg.data.parent} unavailable in the feed)`,
              };
            }

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
            if (id) {
              Goblin.release(goblinName, id);
              resp.events.send(`<${id}.deleted>`, {id});
            }
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
          if (!GOBLINS.has(goblinName)) {
            resp.events.send(
              `${goblinName}.${questName}.${msg.id}.error`,
              new Error(
                `You must call ${goblinName}.create before calling ${questName}`
              )
            );
            return;
          }

          // Single?
          if (GOBLINS.get(goblinName).has(goblinName)) {
            const goblin = GOBLINS.get(goblinName).get(goblinName);

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
          const goblin = GOBLINS.get(goblinName).get(msg.data.id);
          if (!goblin) {
            let from = '';
            if (msg.data._goblinCaller) {
              from = ` from ${msg.data._goblinCaller}.${msg.data._goblinCallerQuest}`;
            }
            const ex = new Error(
              `Error calling quest ${goblinName}.${questName}${from}: goblin with id ${msg.data.id} has not been created`
            );

            if (!msg.data._goblinNoThrow) {
              throw ex;
            }

            resp.log.warn(
              `goblin noThrow enabled: ${ex.stack || ex.message || ex}`
            );
            resp.events.send(`${goblinName}.${questName}.${msg.id}.finished`, {
              _goblinNoThrow: true,
              code: ex.code,
              message: ex.message,
              stack: ex.stack,
            });
            return;
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

    //Shield all wrapped quest with required skills
    for (const [questName, quest] of Object.entries(quests)) {
      guildEnforcer.shield(
        `${goblinName}.${questName}`,
        quest,
        QUESTSMETA[goblinName][questName].options.skills
      );
    }

    return quests;
  }

  static nextGen() {
    return ++GENERATION;
  }

  static getSystemDesktop(desktopId) {
    const session = desktopId.split('@')[1];
    return `system@${session}`;
  }

  static extractGoblinName(goblinId) {
    let name = goblinId;
    if (goblinId.indexOf('@') !== -1) {
      name = goblinId.split('@', 1)[0];
    }
    return name;
  }

  static getGoblinName(goblinId) {
    return Goblin.extractGoblinName(goblinId);
  }

  static getGoblinsRegistry() {
    return GOBLINS;
  }

  static getSessionsRegistry() {
    return SESSIONS;
  }

  static getRC(goblinName) {
    const rc = {};

    Object.keys(QUESTS[goblinName]).forEach((questName) => {
      const params = {};
      const desc = !questName.startsWith('_')
        ? `${questName} for ${goblinName}`
        : null;

      const list = QUESTSMETA[goblinName][questName].params;
      params.required = list.filter((v) => v[0] !== '$');
      params.optional = list.filter((v) => v[0] === '$');

      const questOptions = QUESTSMETA[goblinName][questName].options;
      questOptions.rankingPredictions = guildEnforcer.getRankingPredictions(
        `${goblinName}.${questName}`
      );
      rc[questName] = {
        parallel: true,
        desc,
        options: {
          params,
        },
        questOptions,
        registrar: 'xcraft-core-goblin',
      };
    });

    return rc;
  }

  static getParams(goblinName, questName) {
    return QUESTSMETA[goblinName][questName].params;
  }

  /**
   * Configure a new quest handler.
   *
   * @param {string} goblinName - The instance's type (name).
   * @param {Object} logicState - State for redux.
   * @param {Object} logicHandlers - Reducers for redux.
   * @param {Object} goblinConfig - Specific goblin settings.
   * @returns {Object} the handlers for Xcraft.
   */
  static configure(goblinName, logicState, logicHandlers, goblinConfig) {
    //GUILD: default goblin role
    if (goblinConfig && !goblinConfig.role) {
      goblinConfig.role = 'system';
    } else {
      goblinConfig = {role: 'system'};
    }

    if (!CONFIGS[goblinName]) {
      CONFIGS[goblinName] = {};
    }

    if (!SESSIONS.has(goblinName)) {
      SESSIONS.set(goblinName, new Map());
    }

    CONFIGS[goblinName] = {
      logicState,
      logicHandlers,
      goblinConfig,
    };

    if (!GOBLINS.has(goblinName)) {
      GOBLINS.set(goblinName, new Map());
    }

    const handlers = Goblin.getQuests(goblinName);
    const rc = Goblin.getRC(goblinName);
    return {
      handlers,
      context: getContextManager(),
      rc,
    };
  }

  static create(goblinName, uniqueIdentifier, generation) {
    // Single ?
    if (GOBLINS.get(goblinName).has(goblinName)) {
      throw new Error('A single goblin exist');
    }

    if (
      Object.keys(QUESTSMETA[goblinName]).filter(
        (k) => k === 'init' || k === 'boot'
      ).length > 0
    ) {
      throw new Error(
        `Cannot create goblin ${goblinName}: singleton reserved quest names found in your goblin, please rename 'init' or 'boot' quests to something else`
      );
    }
    const goblinId = uniqueIdentifier || `${goblinName}@${uuidV4()}`;

    if (!generation) {
      throw new Error(`missing generation for ${goblinId}`);
    }

    if (GOBLINS.get(goblinName).has(goblinId)) {
      const goblin = GOBLINS.get(goblinName).get(goblinId);
      goblin._generationId = generation;
      return goblin;
    }

    const goblin = new Goblin(
      goblinId,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].goblinConfig,
      generation
    );

    if (CONFIGS[goblinName].goblinConfig.class) {
      goblin._class = new CONFIGS[goblinName].goblinConfig.class({
        _direct: true,
      });
      for (const questName in QUESTS[goblinName]) {
        QUESTSHANDLES[`${goblinName}/${questName}`] = goblin._class[
          questName
        ].bind(goblin._class);
      }
    }

    //GUILD: dev assign role by config ?
    guildEnforcer.enforce(goblin, CONFIGS[goblinName].goblinConfig.role);
    GOBLINS.get(goblinName).set(goblinId, goblin);
    return goblin;
  }

  static createSingle(goblinName) {
    const xHost = require('xcraft-core-host');
    const appArgs = xHost.appArgs();
    if (appArgs.tribe && appArgs.tribe > 0 && goblinName !== 'goblin') {
      return null;
    }
    if (GOBLINS.get(goblinName).has(goblinName)) {
      throw new Error('A single goblin exist');
    }

    const generation = Goblin.nextGen();

    const goblin = new Goblin(
      goblinName,
      goblinName,
      CONFIGS[goblinName].logicState,
      CONFIGS[goblinName].logicHandlers,
      CONFIGS[goblinName].goblinConfig,
      generation
    );
    //GUILD: dev assign role by config ?
    guildEnforcer.enforce(goblin, CONFIGS[goblinName].goblinConfig.role);
    GOBLINS.get(goblinName).set(goblinName, goblin);
    return goblin;
  }

  static release(goblinName, goblinId) {
    const goblin = GOBLINS.get(goblinName).get(goblinId);
    if (!goblin) {
      const xLog = require('xcraft-core-log')('goblin-core', null);
      xLog.warn(
        `goblin ${goblinId} already disposed; released event received two times?!`
      );
      return;
    }
    goblin.dispose();
    GOBLINS.get(goblinName).delete(goblinId);
    SESSIONS.get(goblinName).delete(goblinId);
  }

  _do(questName, payload = {}, error = false) {
    if (!this._logicHasType(questName)) {
      throw new Error(`Cannot do (${questName}), missing logic handler`);
    }
    this.dispatch(questName, payload, error);
  }

  static questDispatch(goblin, questName, quest, dispatch, done, doneId, next) {
    const questDispatcher = function (type, payload = {}, error = false) {
      const action = createAction(type, payload, error);
      dispatch(action);
    };
    goblin.running(questName, true);
    quest({dispatch: questDispatcher, goblin}, (err) => {
      goblin.running(questName, false);
      if (done) {
        done(doneId);
      }
      next(err);
    });
  }

  dispose() {
    //important: (setter will work on cache)
    this.TTL = 0;
    this._scheduler.dispose();
  }

  constructor(
    goblinId,
    goblinName,
    logicState,
    logicHandlers,
    goblinConfig,
    generation
  ) {
    if (!generation) {
      throw new Error(`missing generation for ${goblinId}`);
    }
    this._generationId = generation;

    const isSingleton = goblinId === goblinName;
    this._scheduler = new Scheduler(
      goblinName,
      Goblin.questDispatch,
      isSingleton
    );

    this._goblinId = goblinId;
    this._goblinName = goblinName;
    this._logger = require('xcraft-core-log')(goblinName, null);
    this._deferrable = [];
    this._goblinConfig = cloneDeep(goblinConfig || {});

    this._runningQuests = {};
    this._feed = {};
    this._TTL = 0;
    this.schedulingMode = this._goblinConfig.schedulingMode || 'foreground';
    this._createMsgIdList = [];

    const ripleyName = isSingleton
      ? this._goblinName
      : `${this._goblinName}-${this._goblinId}`;
    if (this._goblinConfig.ripley && coreGoblinConfig.enableCryo) {
      this._ripley = new Ripley('cryo', ripleyName, null, null);
    } else if (this._goblinConfig.ripley && coreGoblinConfig.enableStateDb) {
      this._ripley = new Ripley('statedb', ripleyName, null, null);
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

    this._logicHasType = (type) => {
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

    let composeEnhancers = (m) => m;
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
        // Save state only after ripley of statedb, not used with cryo
        if (this._ripley._backend.ellenIsAwake) {
          this._logger.verb(`Saving ${this._goblinName} state...`);
          const state = this._store.getState();
          this._ripley.saveState(state.ellen.get(ripleyName));
        }
      });
    }

    watt.wrapAll(this, '_doQuest', 'upserter', 'defers');
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

  get schedulerInfos() {
    return this._scheduler.infos;
  }

  get metrics() {
    if (this._goblinConfig.getMetrics) {
      this._logger.verb(`Gathering metrics for ${this.id}...`);
      let results;
      try {
        results = this._goblinConfig.getMetrics(this);
      } catch (ex) {
        this._logger.warn(`Gathering metrics for ${this.id} failed!`);
        this._logger.warn(ex.stack || ex.message || ex);
        results = {['metricsError.total']: 1};
      }
      return results;
    } else {
      return null;
    }
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
    this.setX('desktopId', feed);
  }

  get feed() {
    return this.getX('desktopId');
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

  get questEmitter() {
    return this._scheduler.questEmitter;
  }

  deferCreateEvent(orcName, msgId, routing, context) {
    this._createMsgIdList.push({orcName, msgId, routing, context});
  }

  isCreating() {
    if (this.goblinName === this._goblinId) {
      return false;
    }
    return this._runningQuests.create && this._runningQuests.create > 0;
  }

  isCreated() {
    if (this.goblinName === this._goblinId) {
      return true;
    }
    return !!this._isCreated;
  }

  isDeleting() {
    if (this.goblinName === this._goblinId) {
      return false;
    }
    return this._runningQuests.delete && this._runningQuests.delete > 0;
  }

  isRunning(questName = null) {
    return questName
      ? this._runningQuests[questName] > 0
      : Object.values(this._runningQuests).some((count) => count > 0);
  }

  running(questName, running) {
    if (!this._runningQuests[questName]) {
      this._runningQuests[questName] = 0;
    }
    this._runningQuests[questName] = running
      ? this._runningQuests[questName] + 1
      : this._runningQuests[questName] - 1;
  }

  runningCount(questName) {
    return this._runningQuests[questName];
  }

  *upserter(quest, payload) {
    payload._upsertQuest = quest.questName;

    //remove private state from upserted data
    payload.data = payload.data.delete('private');

    if (!this.lastUpsertData) {
      this.lastUpsertData = payload.data;
      yield quest.warehouse.upsert(payload);
    } else if (!this.lastUpsertData.equals(payload)) {
      yield quest.warehouse.upsert(payload);
      this.lastUpsertData = payload.data;
    }
  }

  setX(key, value) {
    if (value && value._dontKeepRefOnMe) {
      throw new Error(`You cannot setX with ${key} value`);
    }
    if (!SESSIONS.get(this.goblinName).has(this.id)) {
      SESSIONS.get(this.goblinName).set(this.id, new Map());
    }
    SESSIONS.get(this.goblinName).get(this.id).set(key, value);
  }

  getX(key, fallback) {
    if (!SESSIONS.get(this.goblinName).has(this.id)) {
      if (fallback) {
        const session = new Map();
        session.set(key, fallback);
        SESSIONS.get(this.goblinName).set(this.id, session);
        return session.get(key);
      }
      return null;
    }

    const session = SESSIONS.get(this.goblinName).get(this.id);

    if (fallback && !session.has(key)) {
      session.set(key, fallback);
    }
    return session.get(key);
  }

  delX(key) {
    SESSIONS.get(this.goblinName).get(this.id).delete(key);
  }

  getEllen() {
    return this.store.getState().ellen;
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

  *defers(quest, questName, deferrable) {
    while (deferrable.length > 0) {
      try {
        const defer = deferrable.pop();
        if (isGenerator(defer)) {
          yield watt(defer)();
        } else if (isAsync(defer)) {
          yield defer();
        } else {
          defer();
        }
      } catch (ex) {
        quest.log.err(
          `one defer has failed for ${this._goblinId}/${questName}: ${
            ex.stack || ex.message || ex
          }`
        );
      }
    }
  }

  ///////// ║ ┼ Do quest! ┼ ║ ////////
  /// Welcome to the source core, dear goblin explorator!
  ///
  *_doQuest(questName, msg, resp, context, next) {
    const Quest = require('./quest.js');
    const quest = new Quest(context, questName, msg, resp);

    verifyMessage(msg);
    injectMessageDataGetter(msg);
    const isSingleton = this.goblinName === this._goblinId;
    let isCreating = null;

    let result = null;
    let errThrown = false;
    let canceled = false;

    /* Handling of re-create */
    if (msg.data._goblinRecreate) {
      /* Ensure that the finished events for `create` are sent only when
       * the first `create` is finished.
       */
      if (this._runningQuests.create > 1) {
        this.deferCreateEvent(
          msg.orcName,
          msg.id,
          resp.events.routing,
          msg.context
        );
        return;
      }

      /* Otherwise, the first create is already finished, we can got out
       * as soon as possible because there is nothing to do.
       */
      resp.events.send(
        `${this._goblinName}.create.${msg.id}.finished`,
        this.id
      );
      return;
    }

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
          feeds: quest.getDesktop(true) || 'system',
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
          yield quest.createCache(null);
          const Cache = require('./cache/index.js');
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
        if (questName === 'create' && !parent && !isSingleton) {
          throw new Error(
            `Fatal error ${msg.topic} missing 'parent' parameter`
          );
        }

        let toUpsert = this.getState().state;
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
          feeds: quest.getDesktop(true),
        };

        if (questName === 'create' || isSingleton) {
          payload.parents = parent || this._goblinId;
          if (!quest.hasDispatched && !isSingleton) {
            throw new Error(
              `Your forgot to call quest.do() in create quest of ${this.goblinName}`
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
            yield quest.createCache(null);
            const Cache = require('./cache/index.js');
            yield Cache.rank(this._goblinName, this._goblinId);
          }

          yield this.upsert(quest, payload);
        }
      }
    } catch (ex) {
      errThrown = ex;
    } finally {
      this.getState().detachLogger();
      yield this.defers(quest, questName, quest._deferrable);

      if (!errThrown) {
        if (questName === 'delete' && !canceled) {
          yield this.defers(quest, questName, this._deferrable);

          if (this.useRipley) {
            this._unsubscribeRipley();
          }

          if (this._generationId === msg.data.generation) {
            Goblin.release(this.goblinName, this._goblinId);
            resp.events.send(`<${this._goblinId}.deleted>`, {
              id: this._goblinId,
            });
          }
        }
      }

      if (questName === 'create' && (errThrown || canceled)) {
        /* If an error occurs while the goblin is created, then we must
         * delete its instance.
         */
        yield quest.warehouse.deleteBranch({
          branch: this._goblinId,
        });
      } else if (isCreating === true) {
        yield quest.warehouse.delCreator({
          branch: this._goblinId,
        });
      }

      if (questName === 'create') {
        this._createMsgIdList.push({
          orcName: msg.orcName,
          msgId: msg.id,
          routing: resp.events.routing,
          context: msg.context,
        });
      }

      if (!errThrown) {
        // FINISHED
        try {
          if (questName === 'create') {
            this._isCreated = true;
            for (let i = this._createMsgIdList.length - 1; i >= 0; --i) {
              const {orcName, msgId, routing, context} = this._createMsgIdList[
                i
              ];
              resp.events.send(
                `${orcName}::${this.goblinName}.${questName}.${msgId}.finished`,
                result,
                undefined,
                routing,
                context
              );
            }
          } else {
            resp.events.send(
              `${this.goblinName}.${questName}.${msg.id}.finished`,
              result
            );
          }
        } catch (ex) {
          errThrown = ex;
        }
      }

      if (errThrown) {
        const ex = errThrown;
        const err = ex.stack || ex;
        const errorId = ex.id || quest.uuidV4();

        if (questName === 'create') {
          for (let i = this._createMsgIdList.length - 1; i >= 0; --i) {
            const {orcName, msgId, routing, context} = this._createMsgIdList[i];
            resp.events.send(
              `${orcName}::${this.goblinName}.${questName}.${msgId}.error`,
              {
                id: errorId,
                code: ex.code,
                message: ex.message,
                stack: ex.stack,
              },
              undefined,
              routing,
              context
            );
          }
        } else {
          resp.events.send(`${this.goblinName}.${questName}.${msg.id}.error`, {
            id: errorId,
            code: ex.code,
            message: ex.message,
            stack: ex.stack,
          });
        }

        if (ex.code !== 'SILENT_HILL') {
          quest.log.err({
            id: errorId,
            err: err.stack || err.message || err,
            goblin: {
              id: this._goblinId,
              goblin: this._goblinName,
              quest: questName,
              callerGoblin: msg.data && msg.data._goblinCaller,
              callerQuest: msg.data && msg.data._goblinCallerQuest,
            },
            _xcraftOverwatch: true,
          });
          quest.fail(
            `Error in the quest "${questName}"`,
            err,
            'See ex.',
            err.stack || err.message || err
          );
        } else {
          quest.log.warn(`Silent Hill: ${err.stack || err.message || err}`);
        }
      }

      if (questName === 'create') {
        this._createMsgIdList = [];
      }
    }
  }

  doQuest(questName, msg, resp) {
    return this._doQuest.bind(this, questName, msg, resp);
  }
}

module.exports = Goblin;
module.exports.SmartId = SmartId;
module.exports.Shredder = Shredder;
module.exports.skills = new Proxy(
  {},
  {
    get: (_, k) => {
      const skill = Symbol.for(k);
      guildEnforcer.skills.add(skill);
      return skill;
    },
  }
);

module.exports.ShieldedError = guildEnforcer.ShieldedError;

module.exports.buildGuestFootprint = (clientServiceId, windowId) => {
  if (clientServiceId === 'system') {
    const {appId, appMasterId, variantId} = require('xcraft-core-host');
    let appName = appId;
    if (appMasterId) {
      appName = appMasterId;
    }
    if (variantId) {
      appName = `${appName}-${variantId}`;
    }
    clientServiceId = `${clientServiceId}@${appName}`;
  }

  const {guestHost, guestUser} = osInfo;
  return `guest@${guestUser}@${guestHost}@${clientServiceId}@${windowId}`;
};

module.exports.buildRemoteGuestFootprint = (ctx) => {
  const {ip, socketId, zeppelinSessionId} = ctx;
  return `guest@passenger@${ip}@${zeppelinSessionId}@${socketId}`;
};

//add guild member from JWT token
module.exports.enroleUser = (instance, tokenData) => {
  //todo: check caller instance
  return guildEnforcer.enroleUser(tokenData);
};

module.exports.deroleUser = (instance, tokenData) => {
  //todo: check caller instance
  guildEnforcer.deroleUser(tokenData);
};

module.exports.identifyUser = (msg) => {
  let identified = null;
  if (msg.context && msg.context._goblinUser) {
    try {
      const [userId] = msg.context._goblinUser.split('@', 1);
      if (userId !== 'guest') {
        identified = guildEnforcer.getUser(userId);
      } else {
        if (!guildEnforcer.users[msg.context._goblinUser]) {
          guildEnforcer.addGuestUser(msg.context._goblinUser);
        }
        identified = guildEnforcer.users[msg.context._goblinUser];
      }
      identified._goblinUser = msg.context._goblinUser;
    } catch {
      identified = null;
    }
  }

  if (!identified) {
    const footprint = Goblin.buildGuestFootprint('system', '0');
    if (!guildEnforcer.users[footprint]) {
      guildEnforcer.addGuestUser(footprint);
    }
    identified = guildEnforcer.users[footprint];
    identified._goblinUser = footprint;
  }

  identified.getContext = () => {
    const [
      userId,
      local,
      domain,
      sessionType,
      sessionId,
      windowId,
    ] = identified._goblinUser.split('@', 6);
    return {userId, local, domain, sessionType, sessionId, windowId};
  };
  identified.lastAccess = Date.now();
  return identified;
};

module.exports.dispose = () => {
  guildEnforcer.dispose();
};
