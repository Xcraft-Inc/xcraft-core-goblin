/* eslint-disable jsdoc/valid-types */
/* eslint-disable jsdoc/check-tag-names */
'use strict';

const IS_DEV = process.env.NODE_ENV === 'development';
const {reflect, locks} = require('xcraft-core-utils');
const Shredder = require('xcraft-core-shredder');
const {fromJS} = Shredder;
const {string, number, object, option, boolean} = require('xcraft-core-stones');
const goblinConfig = require('xcraft-core-etc')().load('xcraft-core-goblin');

const {v4: uuidV4} = require('uuid');
const Goblin = require('../index.js');
const utils = require('./utils.js');
const Me = require('./me.js');
const Spirit = require('./spirit.js');
const {directTraps, forwardTraps, meTraps} = require('./traps.js');
const {cacheQuestParams, cacheReduceParams} = require('./params.js');
const CryoReader = require('../cryo/reader.js');
const Runner = require('./runner.js');

/////////////////////////////////////////////////////////////////////////////

/**
 * @template T
 * @template Y
 * @template N
 * @typedef {0 extends (1 & T) ? Y : N} IfAny
 */

class SessionType {
  desktopId = string;
  parent = string;
}

class CreateOption {
  ttl = number;
}

class BusOption {
  rpc = boolean;
}

class ElfOptions {
  session = option(SessionType);
  ripley = option(object);
  create = option(CreateOption);
  bus = option(BusOption);
}

class GetIdsOptions {
  type = option(string);
  last = option(boolean);
}

class Elf {
  static #classes = {};

  /**
   * @private
   * @type {t<SessionType>|undefined}
   */
  _session;

  /**
   * @private
   * @type {t<CreateOption>|undefined}
   */
  _createOption;

  /**
   * @private
   * @type {t<BusOption>|undefined}
   */
  _bus;

  /** @private */ _quest;
  /** @private */ _stateLoaded = false;

  /**
   * @param {*} context Elf's this or quest
   * @param {t<ElfOptions>} [options] Elf's options
   * @returns {Proxy} proxified this
   */
  constructor(context, options) {
    if (options) {
      this._session = options.session;
      this._ripley = options.ripley;
      this._createOption = options.create;
      this._bus = options.bus;
    }

    const goblinName = Elf.goblinName(this.constructor);

    /* Populate the quest params registry with all new elves (even for elves
     * that comes from an other node).
     */
    if (!cacheQuestParams.know(goblinName)) {
      Elf.quests(this).forEach((name) => {
        const params = reflect.funcParams(this[name]);
        cacheQuestParams.register(goblinName, name, params);
      });
    }

    if (IS_DEV) {
      /* Check that the derivated class in not using reserved methods or properties */
      const props = Object.getOwnPropertyDescriptors(
        Object.getPrototypeOf(this)
      );
      if (Me.reserved.some((key) => props[key])) {
        throw new Error(
          `Forbidden use of reserved methods or properties; list of keywords: ${Me.reserved.join(
            ', '
          )}`
        );
      }
    }

    if (context && context.constructor.name !== 'Quest') {
      context = context.quest;
    }

    const traps = context ? forwardTraps : directTraps;

    if (context) {
      this._quest = context;
    }

    if (this instanceof Elf.Alone) {
      this.id = goblinName;
    }

    this._me = new Proxy(this._me, meTraps);

    utils
      .getAllFuncs(this.__proto__, 2)
      .filter((name) => name !== 'dispose' && !Me.reserved.includes(name))
      .forEach((name) => {
        this[name] = new Proxy(this[name], traps);
      });

    return new Proxy(this, traps);
  }

  static _proxyfyLogicState(inputState) {
    const values = {};
    const props = Object.getOwnPropertyNames(inputState).filter(
      (prop) => !prop.startsWith('_') && typeof this[prop] !== 'function'
    );
    /* Keep a copy of all input state values */
    props.forEach((prop) => (values[prop] = inputState[prop]));

    inputState.toJS = function () {
      return this._state.toJS();
    };
    const outputState = new Proxy(inputState, Spirit.traps);

    /* Restore the initial state values into the state by using the Proxy.
     * Then here, it populates the immutable data structure.
     */
    props.forEach((prop) => (outputState[prop] = values[prop]));
    return outputState;
  }

  static _logicState(logicState) {
    return fromJS(logicState?._state ?? {});
  }

  /**
   * @param {*} logic
   * @param {*} quests
   * @param {*} [goblinName]
   * @returns
   */
  static _logicHandlers(logic, quests, goblinName) {
    const handlers = {};

    if (!logic) {
      return handlers;
    }

    const internalLogics = [
      '$4create',
      'persist',
      'insertOrCreate',
      'insertOrReplace',
    ];

    /* Wrap methods into mutable reducers, when it uses the same name
     * that the quests.
     */
    quests
      .filter((name) => !!logic[name])
      .filter((name) => !internalLogics.includes(name))
      .forEach((name) => {
        const params = reflect.funcParams(logic[name]);
        if (goblinName) {
          cacheReduceParams.register(goblinName, name, params);
        }
        const reducer = (state, action, immState) => {
          const args = params.reduce((args, key, index) => {
            args[index] = action.get(key);
            return args;
          }, []);
          logic._state = state;
          logic._immState = immState;
          logic.state._state = state; /* Provide the mutable state into the Proxy */

          const inState = logic.state;
          logic[name].call(logic, ...args);

          /* Check if the state was not overloaded */
          if (logic.state !== inState) {
            throw new Error(`this.state = new AnyState() is forbidden`);
          }
        };
        handlers[name] = Shredder.mutableReducer(reducer);
      });

    /* Logic handlers reserved for internal stuff */
    internalLogics
      .filter((name) => !!logic[name])
      .forEach(
        (name) => (handlers[name] = Shredder.mutableReducer(logic[name]))
      );

    return handlers;
  }

  static quests(elfClass) {
    return utils
      .getAllFuncs(elfClass.prototype || elfClass)
      .filter(
        (name) =>
          name !== 'api' && name !== 'dispose' && !Me.reserved.includes(name)
      );
  }

  static goblinName(derivatedClass) {
    return derivatedClass.name.replace(/^[A-Z]/, (e) => e.toLowerCase());
  }

  static configure(elfClass, logicClass) {
    const goblinName = Elf.goblinName(elfClass);
    const quests = Elf.quests(elfClass);

    /* Quest's options */
    quests.forEach((name) => {
      const options = {elf: true};
      if (elfClass[`${name}Skills`]) {
        options.skills = elfClass[`${name}Skills`];
      }
      Goblin.registerQuest(goblinName, name, elfClass.prototype[name], options);

      const params = reflect.funcParams(elfClass.prototype[name]);
      cacheQuestParams.register(goblinName, name, params);
    });

    /* Goblin's options */
    const config = {class: elfClass};

    let logic;

    if (logicClass) {
      logic = new logicClass();

      /* Register Ripley stuff (Archetype is for Cryo serialization) */
      if (logic instanceof Elf.Archetype) {
        config.db = logicClass.db;

        if (quests.includes('persist')) {
          throw new Error(
            `The "persist" quest of "${goblinName}" is reserved, you must change your quest's name`
          );
        }

        if (!logicClass.db || typeof logicClass.db !== 'string') {
          throw new Error(
            `The static member "db" of "${logicClass.name}" is missing or malformed`
          );
        }

        const cryoManager = require('../cryo/manager.js');

        /* Fake quest for special internal insertOrCreate / insertOrReplace in core-goblin */
        Goblin.registerQuest(goblinName, 'insertOrCreate', () => {});
        Goblin.registerQuest(goblinName, 'insertOrReplace', () => {});

        Goblin.registerQuest(
          goblinName,
          'persist',
          async (quest, action, commitId) => {
            const {id} = quest.goblin;
            const db = quest.goblin?.ripley?.persist?.db;
            const syncClientEnabled = goblinConfig.actionsSync?.enable;
            const isServerSide = !syncClientEnabled;

            if (syncClientEnabled && commitId && db) {
              /* Check if a newer action already exists for this entity.
               * If it's the case, then we skip it because a new bunch of
               * actions will be prepared for the next sync.
               * In other words, we delay the persist provided by the server
               * in order to prevent a rebound with the UI.
               */
              const status = await cryoManager.commitStatus(quest, db, id);
              if (status === 'staged') {
                quest.log.dbg(
                  `Skip persist of ${id} for ${db} where at least one staged actions already exist`
                );
                if (commitId) {
                  const goblin = `${id.split('@', 1)[0]}-${id}`;
                  quest.evt.full(`<${goblin}-${commitId}-freezed>`);
                }
                return;
              }
            }

            /* This hook can be used in orer to update the state just before
             * the final persist. It's very useful when it's necessary to
             * inject something that can be known only by the server side.
             */
            if (isServerSide && commitId) {
              /* beforePersistOnServer */
              if (quest.me.beforePersistOnServer) {
                await quest.me.beforePersistOnServer();
              }
            }

            const state = action
              ? /* Here we persist a specific state */
                JSON.parse(action).payload.state
              : /* Here we persist the goblin's state */
                quest.goblin.getState().toJS();

            if (isServerSide && !commitId) {
              commitId = quest.uuidV4();
              quest.do({state, commitId});
            } else {
              quest.do({state});
            }

            if (isServerSide && db) {
              /* TODO: add meta info for the sender, because this broadcast is for all
               * other clients and the sender should not sync again.
               */
              cryoManager.syncBroadcast(db);
            }
          }
        );
        quests.push('persist');

        const ellenLock = locks.getMutex;
        Goblin.registerQuest(
          goblinName,
          '$4ellen',
          async (quest, actions, commitId) => {
            const goblinId = quest.goblin.id;
            const goblin = `${goblinId.split('@', 1)[0]}-${goblinId}`;
            const db = quest.goblin.ripley.persist.db;

            await ellenLock.lock(goblin);
            quest.defer(() => ellenLock.unlock(goblin));

            /* Check if it's a new entity, in this case it should have only one
             * 'create' action. If it's true, then we replay the received
             * 'create' action. In all other cases, the received 'create' actions
             * must be ignored.
             */
            const cryo = quest.getAPI('cryo');
            const created = await cryo.isAlreadyCreated({db, goblin});

            let persist = false;
            for (const action of actions) {
              if (created && action.type === 'create') {
                continue;
              }

              quest.dispatch(
                action.type,
                action.payload,
                action.meta,
                action.error
              );
              persist = true;
            }

            if (!persist) {
              return null;
            }

            const timer = setTimeout(
              () =>
                quest.log.warn(
                  `[${commitId}] callAndWait timeout of 5s reached for ${goblin}; deadlock?`
                ),
              5000
            );
            quest.defer(() => clearTimeout(timer));

            const err = await quest.sub.callAndWait(
              async () => await quest.me.persist(null, commitId),
              `*::<${goblin}-${commitId}-freezed>`
            );
            if (err) {
              throw err.stack ? err : new Error(err);
            }

            /* return the new persist's hash */
            return {
              action: quest.goblin._ripley.backend.lastPersistedAction,
            };
          }
        );

        /* It's used in ordre to keep only the last persist (no history) */
        const persistMode = logicClass.noHistory ? 'last' : 'all';

        /* Register the ripley settings for all reducers */
        config.ripley = utils
          .getAllFuncs(logicClass.prototype || logicClass)
          .reduce(
            (ripley, logicName) => ({
              ...ripley,
              ...{
                [logicName]: {db: logicClass.db, mode: 'all'},
              },
            }),
            {persist: {db: logicClass.db, mode: persistMode}}
          );
      }

      if (logicClass.prototype.persist) {
        throw new Error(
          `The overload of the "persist" logic handler is forbidden for "${goblinName}"`
        );
      }

      logic.persist = (state, action) => {
        if (action.payload) {
          state._state.clear();
          for (const [k, v] of Object.entries(action.payload.state)) {
            state.set(k, v);
          }
        }
      };

      /* Create reducer used in order to restore a state from Cryo */
      logic.$4create = (state, action) => {
        if (action.payload) {
          state._state.clear();
          for (const [k, v] of Object.entries(action.payload)) {
            state.set(k, v);
          }
        }
      };

      logic.insertOrCreate = logic.$4create;
      logic.insertOrReplace = logic.$4create;

      logic.state = Elf._proxyfyLogicState(logic.state);

      Object.defineProperty(elfClass.prototype, '_getProxifiedState', {
        get() {
          return Elf._proxyfyLogicState(new logicClass().state);
        },
      });
    }

    const configured = Goblin.configure(
      goblinName,
      Elf._logicState(logic?.state),
      Elf._logicHandlers(logic, quests, goblinName),
      config
    );

    if (elfClass !== Elf.Alone && elfClass.prototype instanceof Elf.Alone) {
      Goblin.createSingle(goblinName);
    }

    /* Provide user indices to Cryo.
     * These indices are useful with the JSON actions in order to improve
     * a lot the queryArchetype performances.
     */
    if (logicClass?.indices?.length) {
      configured.handlers._postload = function (msg, resp) {
        try {
          const cryo = require('xcraft-core-cryo');
          cryo._setIndices(logicClass.db, logicClass.indices);
          resp.events.send(`${goblinName}._postload.${msg.id}.finished`);
        } catch (ex) {
          resp.events.send(`${goblinName}._postload.${msg.id}.error`, {
            code: ex.code,
            message: ex.message,
            stack: ex.stack,
          });
        }
      };
    }

    return configured;
  }

  static birth(elfClass, logicClass) {
    const type = Elf.goblinName(elfClass);
    Elf.#classes[type] = elfClass;
    return () => Elf.configure(elfClass, logicClass);
  }

  static getClass(type) {
    return Elf.#classes[type];
  }

  /**
   * Returns an instance of logicClass which can be used for testing only.
   *
   * It's intended to provide working logic handlers for test runner
   * like mocha, ...
   * @example
   * const {Elf} = require('xcraft-core-goblin');
   * const superLogic = Elf.trial(MySuperLogic);
   * superLogic.create('superLogic@test');
   * expect(superLogic.state.id).to.be.equal('superLogic@test');
   * @template T
   * @param {new (...args: any) => T} logicClass
   * @returns {T} instance of logicClass
   */
  static trial(logicClass) {
    const _logic = new logicClass();
    const logicNames = utils.getAllFuncs(_logic);
    _logic.state = Elf._proxyfyLogicState(_logic.state);
    if (!_logic.state._state) {
      _logic.state._state = new Shredder();
    }
    const handlers = Elf._logicHandlers(_logic, logicNames);

    const logic = new logicClass();
    logic.state = _logic.state;

    for (const name of logicNames) {
      logic[name] = (...args) => {
        const params = reflect.funcParams(_logic[name]);
        const _args = params.reduce((obj, key, index) => {
          obj[key] = args[index];
          return obj;
        }, {});

        const action = Goblin.createAction(name, _args);
        handlers[name].call(_logic, _logic.state._state, action);
      };
    }

    return logic;
  }

  static uuid() {
    return uuidV4();
  }

  /**
   * @template {string} T
   * @template {string} U
   * @param {`${T}@${U}`} id
   * @returns {`${T}@${U}`}
   */
  static id(id) {
    return id;
  }

  /**
   * @template {string} T
   * @param {T} type
   * @returns {`${T}@${string}`}
   */
  static newId(type) {
    return `${type}@${Elf.uuid()}`;
  }

  static async $create(id, desktopId, ...args) {
    if (!this._ripley?.persist) {
      return id;
    }

    const insertOrReplace = this.quest.msg.data?._elfInsertOrReplace === true;
    let state = null;
    if (insertOrReplace) {
      state = this.quest.msg.data.state;
    }
    if (!state) {
      state = await this.cryo.getState(this._ripley.persist.db, id);
    }
    if (state) {
      /* Add missing keys (if new entries in the shape) */
      Array.from(this.state._state.keys())
        .filter((key) => !Object.hasOwn(state, key))
        .forEach(
          (key) =>
            (state[key] =
              Shredder.isShredder(this.state[key]) ||
              Shredder.isImmutable(this.state[key])
                ? this.state[key].toJS()
                : this.state[key])
        );
      if (insertOrReplace) {
        /* serialized in database (save and load) */
        this.dispatch('persist', {state});
      } else {
        /* not serialized (load) */
        this.dispatch('$4create', state);
      }
      this._stateLoaded = true;
    } else if (desktopId === 'system@ripley') {
      //put an empty state if actor is created by ripley
      //the final state will be replayed via $4ellen
      this.dispatch('$4create', {id});
      this._stateLoaded = true;
    }

    return id;
  }

  async create(id, ...args) {
    return await Elf.$create.call(this, id, ...args);
  }

  /* Provide this for auto-completion */
  async api(id) {
    return this;
  }

  /** @protected */
  delete() {}

  /**
   * Dispose Elf internal handlers
   *
   * This method must be implemented to dispose low level
   * stuff like timers interval, server handlers, sockets,
   * etc. The Xcraft bus cannot be used here because it's
   * only intended for the final shutdown; maybe the bus is
   * already stopped.
   *
   * Only synchrone calls must be used here.
   * @protected
   */
  dispose() {}

  /* Provide this for auto-completion */
  /**
   * @private
   * @returns {this} this
   */
  _me() {
    return this;
  }

  /**
   * @deprecated Use this.logic instead
   * @protected
   * @param {string} reducer name of the reducer
   * @param {object} [payload] additional values
   * @param {boolean} [error] for error redux actions
   */
  dispatch(reducer, payload = {}, error = false) {}

  /**
   * @deprecated Use this.logic instead
   * @protected
   * @param {object} [props] custom properties to dispatch
   */
  do(props) {}

  /** @protected */
  go() {}

  /**
   * Close the state transaction for Cryo.
   * @protected
   */
  async persist() {}

  /**
   * Try to insert a state (Archetype / Cryo).
   *
   * Maybe it's not possible because the service is already
   * created or a state already exists in Cryo. In this case,
   * this method creates and returns the service API.
   * @example
   * const instance = await new Service(this).insertOrCreate(id, dekstopId, state);
   * if (instance) { //
   *   await instance.patch(state);
   * }
   * @param {*} id
   * @param {*} desktopId
   * @param {Omit<this["state"], "toJS">} state
   * @param {string} [commitId]
   * @return {Promise<*>|undefined}
   */
  async insertOrCreate(id, desktopId, state, commitId) {}

  /**
   * Insert or replace a state (Archetype / Cryo).
   *
   * Maybe it's not possible to insert the state because the
   * service is already created. In this case, this method
   * replaces the state by calling the persist logic reducer
   * (it overloads the current state).
   * @param {*} id
   * @param {*} desktopId
   * @param {Omit<this["state"], "toJS">} state
   */
  async insertOrReplace(id, desktopId, state) {}

  /**
   * Manage multiple Elf instances lifetime with feeds
   *
   * We create the Elves on a specific temporary feed which
   * is killed in order to kill all Elves.
   * @example
   * const feedId = await this.newQuestFeed();
   * await new OtherElf(this).create(id, feedId);
   * @example
   * // With try..finally (legacy)
   * const feedId = Elf.createFeed();
   * try {
   *   await new OtherElf(this).create(id, feedId);
   * } finally {
   *   await this.killFeed(feedId);
   * }
   * @protected
   * @param {string} [prefix] optional prefix to insert after system ex. 'system@{prefix}@<unique-identifer>'
   * @returns {Promise<string>} unique system feed identifier
   */
  async newQuestFeed(prefix) {}

  /**
   * @protected
   * @param {string} feedId For a specific feed
   * @param {boolean} [xcraftRPC] For passive servers
   */
  async killFeed(feedId, xcraftRPC = false) {}

  /**
   * @protected
   * @param {*} ids One ID or an array of IDs
   * @param {*} [parents] Detach from these parents
   * @param {string} [feed] For a specific feed
   * @param {boolean} [xcraftRPC] For passive servers
   */
  async kill(ids, parents, feed, xcraftRPC = false) {}

  /**
   * @protected
   * @returns {import("../quest.js")} the quest context
   */
  get quest() {
    return this._quest;
  }

  /**
   * @protected
   * @returns {ReturnType<import("xcraft-core-log")>} the logger
   */
  get log() {
    return this.quest.log;
  }

  /**
   * @protected
   * @returns {object} the user context
   */
  get user() {
    return {};
  }

  get cryo() {
    return {
      /**
       * @param {string} db
       * @returns {Promise<CryoReader>}
       */
      reader: async (db) => {},
      /**
       * @param {string} db
       * @returns {Promise<Iterable<string>>}
       */
      getDistinctScopes: async (db) => {},
      /**
       * @param {string} db database name
       * @param {string} searchQuery a full text search MATCH query
       * @param {number} [limit] max results
       * @returns {Promise<Iterable<string>>}
       */
      search: async (db, searchQuery, limit = 100) => {},
      /**
       * @param {string} db database name
       * @param {string} searchQuery a full text search MATCH query
       * @param {string[]} locales locales
       * @param {string[]} scopes scopes
       * @param {number} [limit] max results
       * @returns {Promise<Iterable<string>>}
       */
      search2: async (
        db,
        searchQuery,
        locales = [],
        scopes = [],
        limit = 100
      ) => {},
      /**
       * @param {string} db database name
       * @param {string} vectors a vectors MATCH query
       * @param {number} [limit] max results
       * @returns {Promise<Iterable<object>>}
       */
      searchDistance: async (db, vectors, limit = 100) => {},
      /**
       * @param {string} db database name
       * @param {string} vectors a vectors MATCH query
       * @param {string[]} locales locales
       * @param {string[]} scopes scopes
       * @param {number} [limit] max results
       * @returns {Promise<Iterable<object>>}
       */
      searchDistance2: async (
        db,
        vectors,
        locales = [],
        scopes = [],
        limit = 100
      ) => {},
      /**
       * Expert function for internal use
       * @param {string} db database name
       * @param {string} pattern raw string in the action
       * @param {RegExp} regex extractor for the action strings
       * @param {boolean} [lastOnly] only in last persisted state
       * @returns {AsyncIterable<Promise<string>>}
       */
      searchRaw: async function* (db, pattern, regex, lastOnly = true) {},
      /**
       * @template {AnyObjectShape} [T=any]
       * @param {string} db database name
       * @param {IfAny<T, string, t<T>['id']>} id actor id
       * @param {T} [shape]
       * @param {string} [type] action type
       * @returns {Promise<t<T>>}
       */
      getState: async (db, id, shape, type) => {},
      /**
       * @param {string} db database name
       * @param {string} pattern pattern for WHERE clause on {type}-{id} column
       * @param {t<GetIdsOptions>} options options
       * @returns {Promise<Iterable<string>>}
       */
      getIds: async (db, pattern, options) => {},
      /**
       * @param {string} db database name
       * @param {string} type actor type
       * @param {string[]} properties to extract
       * @param {object} [filters] to apply
       * @param {object} [orderBy] optionnal ordering
       * @returns {Promise<Iterable<any>>}
       */
      queryLastActions: async (db, type, properties, filters, orderBy) => {},
      /**
       * @param {string} db database name
       * @param {string} id actor id
       * @param {string[]} properties to extract
       * @returns {Promise<object>}
       */
      pickAction: async (db, id, properties) => {},
      /**
       * Case where the actor is only in the actions table.
       *
       * The actor is not in the lastPersistedActions table if its meta.status
       * is trashed.
       * @param {string} db database name
       * @param {string} id actor id
       * @returns {Promise<boolean>}
       */
      isPersisted: async (db, id) => {},
      /**
       * Case where the actor is available in the lastPersistedActions table.
       *
       * Trashed actors return __false__ here.
       * @param {string} db database name
       * @param {string} id actor id
       * @returns {Promise<boolean>}
       */
      isPublished: async (db, id) => {},
      /**
       * @param {string} db database name
       */
      sync: (db) => {},
      /**
       * Callback for listenTo registering.
       * @callback listenToCallback
       * @param {string} topic event's topic
       * @param {string} id actor's id
       */
      /**
       * Listen to an Elf for changes in Cryo.
       *
       * This method registers the triggers for `elfType` and calls `callback`
       * for all changes in Cryo. The listening stays registered for the whole
       * Elf's live.
       *
       * Note that a initial updated event is sent by listenTo, and in this
       * case the id parameters is null.
       * @param {string} actorType
       * @param {listenToCallback} callback
       */
      listenTo: async (actorType, callback) => {},
    };
  }
}

/////////////////////////////////////////////////////////////////////////////

/**
 * Elf's singleton
 */
class Alone extends Elf {
  async init(...args) {
    return await Elf.$create.call(this, this.id, ...args);
  }
}
Elf.Alone = Alone;

/**
 * Elf's spirit (for states)
 */
Elf.Spirit = Spirit;

/**
 * Elf's body (for states serializations)
 */
class Archetype extends Elf.Spirit {
  static async exist(cryo, actorId) {
    return await cryo.isPersisted(this.db, actorId);
  }
}
Elf.Archetype = Archetype;

/**
 * @template T
 * @template {keyof T} K
 * @typedef {import("xcraft-core-stones/base-types.js").markOptional<T,K>} markOptional
 */
/**
 * @template T
 * @typedef {import("xcraft-core-stones").t<T>} t
 */
/**
 * @typedef {import("xcraft-core-stones").AnyTypeOrShape} AnyTypeOrShape
 */
/**
 * @template T
 * @typedef {{[K in keyof T]: T[K] | undefined}} AllowUndefined
 */

/**
 * @template {AnyTypeOrShape} T
 * @param {T} type the shape
 * @returns {new (_?: AllowUndefined<t<T>>) => t<T>&{toJS: ()=>t<T>}} the sculpted type
 */
function SculptElf(type) {
  /* eslint-disable-next-line @babel/no-unused-expressions */
  type;
  return function (_) {
    return Object.assign(this, _);
  };
}
Elf.Sculpt = SculptElf;

/**
 * Manage multiple Elf instances lifetime with feeds
 *
 * We create the Elves on a specific temporary feed which
 * is killed in order to kill all Elves.
 * @example
 * // With quest.defer
 * const feedId = Elf.createFeed();
 * this.quest.defer(async () => await this.killFeed(feedId));
 * await new Elf(this).create(id, feedId);
 * @example
 * // With try..finally
 * const feedId = Elf.createFeed();
 * try {
 *   await new Elf(this).create(id, feedId);
 * } finally {
 *   await this.killFeed(feedId);
 * }
 * @deprecated Prefer this.newQuestFeed() instead
 * @param {string} [prefix] optional prefix to insert after system ex. 'system@{prefix}@<unique-identifer>'
 * @returns {string} unique system feed identifier
 */
Elf.createFeed = (prefix) => {
  return Me.createFeed(prefix);
};

/**
 * @template T
 * @param {new (...args: any) => T} logicClass
 * @returns {T}
 */
function getLogic(logicClass) {
  return new logicClass();
}
Elf.getLogic = getLogic;

Elf.Runner = Runner;

/////////////////////////////////////////////////////////////////////////////

module.exports = Elf;
