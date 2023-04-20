/* eslint-disable jsdoc/valid-types */
/* eslint-disable jsdoc/check-tag-names */
'use strict';

const Goblin = require('./index.js');
const SmartId = require('./smartId.js');

const Shredder = require('xcraft-core-shredder');
const {fromJS} = Shredder;

const {
  reflect,
  js: {isAsync, isFunction},
} = require('xcraft-core-utils');

function getProperties(obj) {
  const props = {
    ...Object.entries(Object.getOwnPropertyDescriptors(obj))
      .filter(([, handle]) => !isFunction(handle.value))
      .map(([name]) => name)
      .reduce((out, name) => {
        out[name] = true;
        return out;
      }, {}),
  };
  return Object.keys(props);
}

function getAllFuncs(obj, depth = 2) {
  let props = {};

  for (let i = 0; i < depth; ++i) {
    props = {
      ...props,
      ...Object.entries(Object.getOwnPropertyDescriptors(obj))
        .filter(
          ([name, handle]) =>
            name !== 'constructor' && !handle.set && !handle.get
        )
        .map(([name]) => name)
        .reduce((out, name) => {
          out[name] = true;
          return out;
        }, {}),
    };
    obj = Object.getPrototypeOf(obj);
  }

  return Object.keys(props);
}

const reserved = [
  'dispatch',
  'do',
  'go',
  'kill',
  'quest',
  'log',
  '_me',
  'state',
  'user',
];

/**
 * Wrapper for quest.me
 */
class Me {
  #quest;

  constructor(quest) {
    this.#quest = quest;

    const _me = Object.assign({}, quest.me);
    reserved.forEach((key) => delete _me[key]);
    Object.assign(this, _me, quest.elf);

    /* Replace properties by getter / setter */
    const props = getProperties(quest.elf);
    props.forEach((prop) => {
      delete this[prop];

      /* Special wrapping in order to return the appropriate
       * goblin's state from this.state in the quests.
       */
      if (prop === 'state') {
        Object.defineProperty(this, prop, {
          get() {
            quest.elf.state = quest.elf._getProxifiedState;
            quest.elf.state._state = quest.goblin.getState();
            return quest.elf.state;
          },
        });
        return;
      }

      /* Specific properties defined for the Elf */
      Object.defineProperty(this, prop, {
        get() {
          return quest.elf[prop];
        },
        set(value) {
          quest.elf[prop] = value;
        },
      });
    });
  }

  get dispatch() {
    return this.#quest.dispatch.bind(this.#quest);
  }

  get do() {
    return this.#quest.do.bind(this.#quest);
  }

  get go() {
    return this.#quest.go.bind(this.#quest);
  }

  get kill() {
    return this.#quest.kill.bind(this.#quest);
  }

  get quest() {
    return this.#quest;
  }

  get log() {
    return this.#quest.log;
  }

  get user() {
    return this.#quest.user;
  }
}

/**
 * Traps used from the server side (real calls)
 */
const directHooks = {
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
        name === 'create' && // TODO delete
        self.__proto__[name] === target &&
        self.__proto__[name] !== self.__proto__.__proto__[name]
      ) {
        await target.bind(me)(...args);
      }
      return res;
    }

    toCall.bind(me)(...args);
    if (
      name === 'create' && // TODO delete
      self.__proto__[name] === target &&
      self.__proto__[name] !== self.__proto__.__proto__[name]
    ) {
      return target.bind(me)(...args);
    }
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

function checkId(id, goblinName) {
  const smartId = new SmartId(id, goblinName);
  if (!smartId.isValid()) {
    throw new Error(
      `You can't create a new '${id}' with the goblin '${goblinName}'`
    );
  }
}

/**
 * Traps for the client (consumer) side, commands sent on the bus
 */
const forwardTraps = {
  async apply(target, self, args) {
    const {name} = target;
    const goblinName = Elf.goblinName(self.constructor);

    if (name === 'api') {
      checkId(args[0], goblinName);
      self.id = args[0];
      const api = self.quest.getAPI(args[0]);
      api._elf = true;
      return api;
    }

    if (name === 'create') {
      /* map args to object for the create */
      const params = Goblin.getParams(goblinName, name);
      const _args = params.reduce((obj, key, index) => {
        obj[key] = args[index];
        return obj;
      }, {});

      checkId(_args.id, goblinName);
      self.id = _args.id;
      if (!_args.desktopId) {
        _args.desktopId = self.quest.getDesktop();
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

/**
 * Wrapper for the arrays used on a Elf's state.
 */
class List {
  /** Root state */
  _state;
  /** Absolute path for the array */
  _path;

  constructor(state, path) {
    this._state = state;
    this._path = path;
  }

  push(...args) {
    return this._state.state.updateIn(this._path, (list) => list.push(...args));
  }

  includes(...args) {
    return this._state.state.getIn(this._path).includes(...args);
  }
}

/**
 * Traps dedicated to the Elf's reducers.
 */
const stateTraps = {
  get(state, prop) {
    if (prop.startsWith('_') || typeof state[prop] === 'function') {
      return Reflect.get(...arguments);
    }

    if (Array.isArray(state[prop])) {
      return new List(state._state, state?._path?.concat(prop) || [prop]);
    }

    if (state[prop] !== null && typeof state[prop] === 'object') {
      const _path = state._path || [];
      _path.push(prop);
      return new Proxy(
        {_state: state._state, _path, ...state[prop]},
        stateTraps
      );
    }

    return state._state.get(state?._path?.concat(prop) || [prop]);
  },
  set(state, prop, value) {
    if (prop.startsWith('_') || typeof state[prop] === 'function') {
      Reflect.set(...arguments);
      return true;
    }
    if (!state._state) {
      state._state = new Shredder();
    }
    state._state = state._state.set(
      state?._path?.concat(prop) || [prop],
      value
    );
    return true;
  },
  deleteProperty(state, prop) {
    if (prop in state) {
      state._state.state.deleteIn(state?._path?.concat(prop) || [prop]);
      return true;
    }
  },
};

class Elf {
  constructor(context) {
    /* Check that the derivated class in not using reserved methods or properties */
    if (
      reserved.some(
        (key) =>
          Object.getOwnPropertyDescriptors(Object.getPrototypeOf(this))[key]
      )
    ) {
      throw new Error(
        `Forbidden use of reserved methods or properties; list of keywords: ${reserved.join(
          ', '
        )}`
      );
    }

    if (context && context.constructor.name !== 'Quest') {
      context = context.quest;
    }

    const hooks = context ? forwardTraps : directHooks;

    if (context) {
      /** @private */
      this._quest = context;
    }

    if (this instanceof Elf.Alone) {
      this.id = Elf.goblinName(this.constructor);
    }

    /** @private */
    this._me = new Proxy(this._me, meTraps);

    getAllFuncs(this.__proto__, 2)
      .filter((name) => !reserved.includes(name))
      .forEach((name) => {
        this[name] = new Proxy(this[name], hooks);
      });

    return new Proxy(this, hooks);
  }

  static _logicState(logicClass) {
    return fromJS(logicClass?._state ?? {});
  }

  static _logicHandlers(logicClass, quests) {
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

  static goblinName(derivatedClass) {
    return derivatedClass.name.replace(/^[A-Z]/, (e) => e.toLowerCase());
  }

  static configure(elfClass, logicClass) {
    const goblinName = Elf.goblinName(elfClass);

    const quests = getAllFuncs(elfClass.prototype).filter(
      (name) => name !== 'api' && !reserved.includes(name)
    );

    quests.forEach((name) => {
      const options = {};
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

      logic.state = new Proxy(logic.state, stateTraps);

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
      Elf._logicHandlers(logic, quests),
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

  static create(id) {
    this.set('id', id);
  }
  async create(id) {
    return id;
  }

  /* Provide this for auto-completion */
  async api(id) {
    return this;
  }

  /* Provide this for auto-completion */
  /**
   * @private
   * @returns {this} this
   */
  _me() {
    return this;
  }

  /** @protected */
  delete() {}

  /** @protected */
  dispatch() {}

  /** @protected */
  do(props) {}

  /** @protected */
  go() {}

  /**
   * @protected
   * @param {*} ids - One ID or an array of IDs
   * @param {*} [parents] - Detach from these parents
   * @param {string} [feed] - For a specific feed
   */
  async kill(ids, parents, feed) {}

  /** @protected */
  get quest() {
    return this._quest;
  }

  /** @protected */
  get log() {
    return {};
  }

  /** @protected */
  get user() {
    return {};
  }
}

/**
 * Singleton
 */
class Alone extends Elf {}
Elf.Alone = Alone;

/**
 * Elf's reducers based on Shredder.
 *
 * This class offers traps on Stone's states that translates natural
 * javascript object manipulations into immutable.js data structure.
 */
class Spirit {
  static #log = require('xcraft-core-log')('spirit');

  _state = new Shredder();
  _immState;

  /**
   * @returns {object} javascript object from the immutable state
   */
  toJS() {
    return this._state.toJS();
  }

  /**
   * @readonly
   * @memberof Spirit
   * @returns {Shredder} immutable Shredder state
   */
  get immutable() {
    return this._immState;
  }

  /**
   * @readonly
   * @memberof Spirit
   * @returns {*} Xcraft logger
   */
  get log() {
    return Spirit.#log;
  }
}
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
 * @param {T} type
 * @returns {new (_?: markOptional<t<T>, 'id'>) => t<T>}
 */
function SculptElf(type) {
  type;
  return function (_) {
    return _;
  };
}
Elf.Sculpt = SculptElf;

module.exports = Elf;
