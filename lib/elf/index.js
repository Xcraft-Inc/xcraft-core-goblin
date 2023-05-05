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

const {v4: uuidV4} = require('uuid');
const Goblin = require('../index.js');
const utils = require('./utils.js');
const Me = require('./me.js');
const Spirit = require('./spirit.js');
const CacheParams = require('./cacheParams.js');

/////////////////////////////////////////////////////////////////////////////

const cacheParams = new CacheParams();

/////////////////////////////////////////////////////////////////////////////

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
      const res = await toCall.bind(me)(...args);
      if (
        (name === 'create' || name === 'delete') &&
        self.__proto__[name] === target &&
        self.__proto__[name] !== self.__proto__.__proto__[name]
      ) {
        /* Internal elf's create call, returns id */
        await target.bind(me)(...args);
      }
      return res;
    }

    const res = toCall.bind(me)(...args);
    if (
      (name === 'create' || name === 'delete') &&
      self.__proto__[name] === target &&
      self.__proto__[name] !== self.__proto__.__proto__[name]
    ) {
      /* Internal elf's create call, returns id */
      return target.bind(me)(...args);
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
    const api = quest.getAPI(quest.goblin.id);
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

    const api = self.quest.getAPI(self.id);
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

  /**
   * @param {*} context Elf's this or quest
   * @param {t<SessionType>} [session] Pass a passive server session
   * @returns {Proxy} proxified this
   */
  constructor(context, session) {
    this._session = session;

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
      /** @private */
      this._quest = context;
    }

    if (this instanceof Elf.Alone) {
      this.id = goblinName;
    }

    /** @private */
    this._me = new Proxy(this._me, meTraps);

    utils
      .getAllFuncs(this.__proto__, 2)
      .filter((name) => !Me.reserved.includes(name))
      .forEach((name) => {
        this[name] = new Proxy(this[name], traps);
      });

    return new Proxy(this, traps);
  }

  static _logicState(logicClass) {
    return fromJS(logicClass?._state ?? {});
  }

  static _logicHandlers(goblinName, logicClass, quests) {
    const handlers = {};

    if (!logicClass) {
      return handlers;
    }

    /* Wrap methods into mutable reducers, when it uses the same name
     * that the quests.
     */
    quests
      .filter((name) => !!logicClass[name])
      .forEach((name) => {
        const params = reflect.funcParams(logicClass[name]);
        cacheParams.register(goblinName, name, params);
        const reducer = (state, action, immState) => {
          const args = params.reduce((args, key, index) => {
            args[index] = action.get(key);
            return args;
          }, []);
          logicClass._state = state;
          logicClass._immState = immState;
          logicClass.state._state = state; /* Provide the mutable state into the Proxy */
          logicClass[name].call(logicClass, ...args);
        };
        handlers[name] = Shredder.mutableReducer(reducer);
      });

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

    quests.forEach((name) => {
      const options = {elf: true};
      if (elfClass[`${name}Skills`]) {
        options.skills = elfClass[`${name}Skills`];
      }
      Goblin.registerQuest(goblinName, name, elfClass.prototype[name], options);
    });

    let logic;

    if (logicClass) {
      logic = new logicClass();

      const values = {};
      const props = Object.getOwnPropertyNames(logic.state).filter(
        (prop) => !prop.startsWith('_') && typeof this[prop] !== 'function'
      );
      /* Keep a copy of all initial state values */
      props.forEach((prop) => (values[prop] = logic.state[prop]));

      logic.state = new Proxy(logic.state, Spirit.traps);

      /* Restore the initial state values into the state by using the Proxy.
       * Then here, it populates the immutable data structure.
       */
      props.forEach((prop) => (logic.state[prop] = values[prop]));

      Object.defineProperty(elfClass.prototype, '_getProxifiedState', {
        get() {
          return logic.state;
        },
      });
    }

    const configured = Goblin.configure(
      goblinName,
      Elf._logicState(logic?.state),
      Elf._logicHandlers(goblinName, logic, quests),
      {class: elfClass}
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

  async create(id) {
    return id;
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
}

/////////////////////////////////////////////////////////////////////////////

/**
 * Elf's singleton
 */
class Alone extends Elf {}
Elf.Alone = Alone;

/**
 * Elf's spirit (for states)
 */
Elf.Spirit = Spirit;

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
 * @returns {new (_?: markOptional<t<T>, 'id'>) => t<T>} the sculpted type
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
