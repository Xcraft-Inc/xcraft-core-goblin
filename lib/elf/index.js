/* eslint-disable jsdoc/valid-types */
/* eslint-disable jsdoc/check-tag-names */
'use strict';

const {
  reflect,
  js: {isAsync},
} = require('xcraft-core-utils');
const Shredder = require('xcraft-core-shredder');
const {fromJS} = Shredder;
const {string} = require('xcraft-core-stones');
const xLog = require('xcraft-core-log')('elf', null);

const {v4: uuidV4} = require('uuid');
const Goblin = require('../index.js');
const utils = require('./utils.js');
const Me = require('./me.js');
const Spirit = require('./spirit.js');
const CacheParams = require('./cacheParams.js');

/////////////////////////////////////////////////////////////////////////////

const cacheParams = new CacheParams();

/////////////////////////////////////////////////////////////////////////////

const isCreate = (name) => name === 'create' || name === 'init';
const isReserved = (name) => isCreate(name) || name === 'delete';

/**
 * Traps used from the server side (real calls)
 */
const directTraps = {
  async apply(target, self, args) {
    /* Case where the server side is calling a quest.me quest for example */
    if (self instanceof Me) {
      const quest = self.quest;
      self = self.quest.elf;
      self.id = quest.goblin.id;
      self._quest = quest;
      return await forwardTraps.apply(target, self, args);
    }

    const {name} = target;
    const toCall = self.__proto__.__proto__[name] ?? self.__proto__[name];
    const quest = args.shift(1);
    const me = new Me(quest);

    if (isAsync(target)) {
      /* Internal elf's create call, returns id */
      const res = await toCall.bind(me)(...args);
      if (
        isReserved(name) &&
        self.__proto__[name] === target &&
        self.__proto__[name] !== self.__proto__.__proto__[name]
      ) {
        if (!me._ripley || (isCreate(name) && !me._stateLoaded)) {
          await target.bind(me)(...args);
        }
      }
      return res;
    }

    /* Internal elf's create call, returns id */
    const res = toCall.bind(me)(...args);
    if (
      isReserved(name) &&
      self.__proto__[name] === target &&
      self.__proto__[name] !== self.__proto__.__proto__[name]
    ) {
      if (!me._ripley || (isCreate(name) && !me._stateLoaded)) {
        target.bind(me)(...args);
      }
    }
    return res;
  },
};

/**
 * Specific trap to return the Elf own API
 */
const meTraps = {
  apply(target, self, args) {
    const quest = args[0];
    const api = quest.getAPI(quest.goblin.id, quest.goblin.goblinName, true);
    api._elf = true;
    return api;
  },
};

/**
 * Traps for the client (consumer) side, commands sent on the bus
 */
const forwardTraps = {
  async apply(target, self, args) {
    const {name} = target;
    const goblinName = Elf.goblinName(self.constructor);

    if (name === 'api') {
      utils.checkId(args[0], goblinName);
      self.id = args[0];
      const api = self.quest.getAPI(args[0]);
      api._elf = true;
      return api;
    }

    if (name === 'create') {
      /* map args to object for the create */
      const params = cacheParams.get(goblinName, name);
      const _args = params.reduce((obj, key, index) => {
        obj[key] = args[index];
        return obj;
      }, {});

      utils.checkId(_args.id, goblinName);
      self.id = _args.id;
      if (!_args.desktopId) {
        _args.desktopId = self.quest.getDesktop();
      }
      if (self._session) {
        _args._xcraftRPC = true;
        _args.desktopId = self._session.desktopId;
        _args.parent = self._session.parent;
      }
      const api = await self.quest.create(goblinName, _args);
      api._elf = true;
      return api;
    }

    const api = self.quest.getAPI(self.id, self.goblinName, true);
    api._elf = true; /* args are mapped to object by getAPI */
    return await api[name](...args);
  },
};

/////////////////////////////////////////////////////////////////////////////

class SessionType {
  desktopId = string;
  parent = string;
}

class Elf {
  /**
   * @private
   * @type {t<SessionType>|undefined}
   */
  _session;

  /** @private */ _quest;
  /** @private */ _stateLoaded = false;

  /**
   * @param {*} context Elf's this or quest
   * @param {t<SessionType>} [session] Pass a passive server session
   * @param {object} [ripley] The Ripley config
   * @returns {Proxy} proxified this
   */
  constructor(context, session, ripley) {
    this._session = session;

    if (ripley) {
      this._ripley = ripley;
    }

    const goblinName = Elf.goblinName(this.constructor);

    /* Populate the quest params registry with all new elves (even for elves
     * that comes from an other node).
     */
    if (!cacheParams.know(goblinName)) {
      Elf.quests(this).forEach((name) => {
        const params = reflect.funcParams(this[name]);
        cacheParams.register(goblinName, name, params);
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

  static _logicHandlers(logic, quests) {
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
      cacheParams.register(goblinName, name, params);
    });

    /* Goblin's options */
    const goblinConfig = {class: elfClass};

    let logic;

    if (logicClass) {
      logic = new logicClass();

      /* Register Ripley stuff (Archetype is for Cryo serialization) */
      if (logic instanceof Elf.Archetype) {
        goblinConfig.db = logicClass.db;

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

        Goblin.registerQuest(goblinName, 'persist', (quest, action) => {
          const state = action
            ? /* Here we persist a specific state */
              JSON.parse(action).payload.state
            : /* Here we persist the goblin's state */
              quest.goblin.getState().toJS();

          quest.do({state});
        });
        quests.push('persist');

        Goblin.registerQuest(goblinName, '$4ellen', async (quest, actions) => {
          // TODO: lock by goblinId
          for (const action of actions) {
            quest.dispatch(
              action.type,
              action.payload,
              action.meta,
              action.error
            );
          }
          /* return the new persist's hash */
          await quest.me.persist();
          // TODO: broadcast event (new persist)
          return {
            hash: quest.goblin._ripley.backend.lastPersistedHash,
            action: quest.goblin._ripley.backend.lastPersistedAction,
          };
        });

        /* Register the ripley settings for all reducers */
        goblinConfig.ripley = utils
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
        xLog.warn(
          `The overload of the "persist" logic handler is tolerated for "${goblinName}", but anyway you should change your logic`
        );
      } else {
        logic.persist = function (state) {
          for (const [k, v] of Object.entries(state)) {
            this.state[k] = v;
          }
        };
      }

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
          return logic.state;
        },
      });
    }

    const configured = Goblin.configure(
      goblinName,
      Elf._logicState(logic?.state),
      Elf._logicHandlers(logic, quests),
      goblinConfig
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

  static async $create(id, ...args) {
    if (this._ripley?.persist) {
      const state = await this.cryo.getState(
        this._ripley.persist.db,
        id,
        'persist',
        'local'
      );
      if (state) {
        this.dispatch('$4create', state);
        this._stateLoaded = true;
      }
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
   * @protected
   * @param {string} reducer name of the reducer
   * @param {object} [payload] additional values
   * @param {boolean} [error] for error redux actions
   */
  dispatch(reducer, payload = {}, error = false) {}

  /**
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
       *
       * @param {*} db database name
       * @param {*} id blob identifier ex. blob@<hash>
       * @param {*} destPathFolder your final destination
       */
      extractBlob: async (db, id, destPathFolder) => {},
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
       * @param {string} [source] local or remote
       * @returns {Promise<object>}
       */
      getState: async (db, id, type, source = 'local') => {},
      /**
       * @param {string} db database name
       * @param {string} pattern pattern for WHERE clause on {type}-{id} column
       * @param {string} type action type
       * @param {string} [source] local or remote
       * @returns {Promise<Iterable<string>>}
       */
      getIds: async (db, pattern, type, source = 'local') => {},
      /**
       * @param {string} db database name
       * @param {string} type actor type
       * @param {string[]} properties to extract
       * @param {object} filters to apply
       * @returns {Promise<Iterable<any>>}
       */
      queryLastActions: async (db, type, properties, filters) => {},
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
class Archetype extends Elf.Spirit {}
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
 * @returns {new (_?: markOptional<t<T>, 'id'>) => t<T>&{toJS: ()=>t<T>}} the sculpted type
 */
function SculptElf(type) {
  type;
  return function (_) {
    return Object.assign(this, _);
  };
}
Elf.Sculpt = SculptElf;

/////////////////////////////////////////////////////////////////////////////

module.exports = Elf;
