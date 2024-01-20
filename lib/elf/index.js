/* eslint-disable jsdoc/valid-types */
/* eslint-disable jsdoc/check-tag-names */
'use strict';

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

/////////////////////////////////////////////////////////////////////////////

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

class Elf {
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

    /* Check that the derivated class in not using reserved methods or properties */
    if (
      Me.reserved.some(
        (key) =>
          Object.getOwnPropertyDescriptors(Object.getPrototypeOf(this))[key]
      )
    ) {
      throw new Error(
        `Forbidden use of reserved methods or properties; list of keywords: ${Me.reserved.join(
          ', '
        )}`
      );
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
      .filter((name) => !Me.reserved.includes(name))
      .forEach((name) => {
        this[name] = new Proxy(this[name], traps);
      });

    return new Proxy(this, traps);
  }

  static #proxyfyLogicState(inputState) {
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

  static _logicHandlers(logic, quests, goblinName) {
    const handlers = {};

    if (!logic) {
      return handlers;
    }

    /* Wrap methods into mutable reducers, when it uses the same name
     * that the quests.
     */
    quests
      .filter((name) => !!logic[name])
      .forEach((name) => {
        const params = reflect.funcParams(logic[name]);
        cacheReduceParams.register(goblinName, name, params);
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

    if (logic.$4create) {
      handlers.$4create = Shredder.mutableReducer(logic.$4create);
    }
    if (logic.persist) {
      handlers.persist = Shredder.mutableReducer(logic.persist);
    }

    return handlers;
  }

  static quests(elfClass) {
    return utils
      .getAllFuncs(elfClass.prototype || elfClass)
      .filter((name) => name !== 'api' && !Me.reserved.includes(name));
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

        /* Fake quest for special internal quickCreate in core-goblin */
        Goblin.registerQuest(goblinName, 'quickCreate', () => {});

        Goblin.registerQuest(
          goblinName,
          'persist',
          async (quest, action, commitId) => {
            const syncClientEnabled = goblinConfig.actionsSync?.enable;

            /* This hook can be used in orer to update the state just before
             * the final persist. It's very useful when it's necessary to
             * inject something that can be known only by the server side.
             */
            if (!syncClientEnabled && commitId) {
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

            if (!syncClientEnabled && !commitId) {
              commitId = quest.uuidV4();
              quest.do({state, commitId});
            } else {
              quest.do({state});
            }

            if (!syncClientEnabled) {
              const db = quest.goblin?.ripley?.persist?.db;
              if (db) {
                /* TODO: add meta info for the sender, because this broadcast is for all
                 * other clients and the sender should not sync again.
                 */
                const cryoManager = require('../cryo/manager.js');
                cryoManager.syncBroadcast(quest, db);
              }
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

            /* Check if it's a new entity, in this case it should have only one 'create'
             * action. If it's true, then we replay the received 'create' action. In all
             * other cases, the received 'create' actions must be ignored.
             */
            const cryo = quest.getAPI('cryo');
            const createCnt = await cryo.countCreate({db, goblin});
            const skipCreate = createCnt?.count && createCnt.count > 1;

            let persist = false;
            for (const action of actions) {
              if (skipCreate && action.type === 'create') {
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

            await quest.sub.callAndWait(
              async () => await quest.me.persist(null, commitId),
              `*::<${goblin}-${commitId}-freezed>`
            );

            /* return the new persist's hash */
            return {
              action: quest.goblin._ripley.backend.lastPersistedAction,
            };
          }
        );

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
            {persist: {db: logicClass.db, mode: 'all'}}
          );
      }

      if (logicClass.prototype.persist) {
        throw new Error(
          `The overload of the "persist" logic handler is forbidden for "${goblinName}"`
        );
      }

      logic.persist = (state, action) => {
        if (action.payload) {
          for (const [k, v] of Object.entries(action.payload.state)) {
            state.set(k, v);
          }
        }
      };

      /* Create reducer used in order to restore a state from Cryo */
      logic.$4create = (state, action) => {
        if (action.payload) {
          for (const [k, v] of Object.entries(action.payload)) {
            state.set(k, v);
          }
        }
      };

      logic.state = Elf.#proxyfyLogicState(logic.state);

      Object.defineProperty(elfClass.prototype, '_getProxifiedState', {
        get() {
          return Elf.#proxyfyLogicState(new logicClass().state);
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

    return configured;
  }

  static birth(elfClass, logicClass) {
    return () => Elf.configure(elfClass, logicClass);
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

    const quickCreate = this.quest.msg.data?._elfQuickCreate === true;
    let state = null;
    if (quickCreate) {
      state = this.quest.msg.data.state;
    }
    if (!state) {
      state = await this.cryo.getState(this._ripley.persist.db, id, 'persist');
    }
    if (state) {
      if (quickCreate) {
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
   *
   * @protected
   */
  async persist() {}

  /**
   * @param {*} id
   * @param {*} state
   */
  async quickCreate(id, desktopId, state) {}

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
   * @returns {*} the quest context
   */
  get quest() {
    return this._quest;
  }

  /**
   * @protected
   * @returns {object} the logger
   */
  get log() {
    return {};
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
       * @param {string} db database name
       * @param {string} searchQuery a full text search MATCH query
       * @returns {Promise<Iterable<string>>}
       */
      search: async (db, searchQuery) => {},
      /**
       * @param {string} db database name
       * @param {string} id actor id
       * @param {string} type action type
       * @returns {Promise<object>}
       */
      getState: async (db, id, type) => {},
      /**
       * @param {string} db database name
       * @param {string} pattern pattern for WHERE clause on {type}-{id} column
       * @param {string} type action type
       * @returns {Promise<Iterable<string>>}
       */
      getIds: async (db, pattern, type) => {},
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
       * @param {string} db database name
       * @param {string} id actor id
       * @returns {Promise<boolean>}
       */
      isPersisted: async (db, id) => {},
      /**
       * @param {string} db database name
       * @returns {Promise<Iterable<any>>}
       */
      sync: async (db) => {},
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
 * @template {AnyTypeOrShape} T
 * @param {T} type the shape
 * @returns {new (_?: Partial<t<T>>) => t<T>&{toJS: ()=>t<T>}} the sculpted type
 */
function SculptElf(type) {
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
 *
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
 * @returns {string} unique system feed identifier
 */
Elf.createFeed = () => {
  return `system@${Elf.uuid()}`;
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

/////////////////////////////////////////////////////////////////////////////

module.exports = Elf;
