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

  get state() {
    return this.#quest.goblin.getState();
  }

  get user() {
    return this.#quest.user;
  }
}

/* Hooks use from the server side (real calls) */
const directHooks = {
  async apply(target, self, args) {
    /* Case where the server side is calling a quest.me quest for example */
    if (self instanceof Me) {
      const quest = self.quest;
      self = self.quest.elf;
      self.id = quest.goblin.id;
      self._quest = quest;
      return await forwardHooks.apply(target, self, args);
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

/* Specific hook to return its own API */
const meHooks = {
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

/* Hooks for the client (consumer) side, commands sent on the bus */
const forwardHooks = {
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

    const params = Goblin.getParams(goblinName, name);
    const _args = params.reduce((obj, key, index) => {
      obj[key] = args[index];
      return obj;
    }, {});

    if (name === 'create') {
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
    api._elf = true;
    return await api[name](_args);
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

    const hooks = context ? forwardHooks : directHooks;

    if (context) {
      /** @private */
      this._quest = context;
    }

    /** @private */
    this._me = new Proxy(this._me, meHooks);

    getAllFuncs(this.__proto__, 2)
      .filter((name) => !reserved.includes(name))
      .forEach((name) => {
        this[name] = new Proxy(this[name], hooks);
      });

    return new Proxy(this, hooks);
  }

  static _logicState(stateClass) {
    return fromJS(stateClass?._state ?? {});
  }

  static _logicHandlers(stateClass, quests) {
    const handlers = {};

    if (!stateClass) {
      return handlers;
    }

    quests
      .filter((name) => !!stateClass[name])
      .forEach((name) => {
        const params = reflect.funcParams(stateClass[name]);
        const reducer = (state, action, immState) => {
          const args = params.reduce((args, key, index) => {
            args[index] = action.get(key);
            return args;
          }, []);
          stateClass._state = state;
          stateClass._immState = immState;
          stateClass.state._state = state;
          stateClass[name].call(stateClass, ...args);
        };
        handlers[name] = Shredder.mutableReducer(reducer);
      });
    return handlers;
  }

  static goblinName(derivatedClass) {
    return derivatedClass.name.replace(/^[A-Z]/, (e) => e.toLowerCase());
  }

  static configure(derivatedClass) {
    const goblinName = Elf.goblinName(derivatedClass);

    const quests = getAllFuncs(derivatedClass.prototype).filter(
      (name) => name !== 'api' && !reserved.includes(name)
    );

    quests.forEach((name) => {
      const options = {};
      if (derivatedClass[`${name}Skills`]) {
        options.skills = derivatedClass[`${name}Skills`];
      }
      Goblin.registerQuest(
        goblinName,
        name,
        derivatedClass.prototype[name],
        options
      );
    });

    if (derivatedClass.initialState) {
      const values = {};
      const props = Object.getOwnPropertyNames(
        derivatedClass.initialState.state
      ).filter(
        (prop) => !prop.startsWith('_') && typeof this[prop] !== 'function'
      );
      props.forEach(
        (prop) => (values[prop] = derivatedClass.initialState.state[prop])
      );

      derivatedClass.initialState.state = new Proxy(
        derivatedClass.initialState.state,
        stateHooks
      );

      props.forEach(
        (prop) => (derivatedClass.initialState.state[prop] = values[prop])
      );
    }

    const configured = Goblin.configure(
      goblinName,
      Elf._logicState(derivatedClass.initialState?.state),
      Elf._logicHandlers(derivatedClass.initialState, quests),
      {class: derivatedClass}
    );

    if (
      derivatedClass !== Elf.Alone &&
      derivatedClass.prototype instanceof Elf.Alone
    ) {
      Goblin.createSingle(goblinName);
    }

    return configured;
  }

  static birth(derivatedClass) {
    return () => Elf.configure(derivatedClass);
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

  /** @private */
  delete() {}

  /** @protected */
  dispatch() {}

  /** @protected */
  do(props) {}

  /** @protected */
  go() {}

  /**
   * @protected
   * @param {(SmartId[]|SmartId)} ids - One ID or an array of IDs
   * @param {(SmartId[]|SmartId)} [parents] - Detach from these parents
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
  get state() {
    return new Goblin.Shredder();
  }

  /** @protected */
  get user() {
    return {};
  }
}

class Alone extends Elf {}
Elf.Alone = Alone;

class List {
  _state;
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

const stateHooks = {
  get(state, prop) {
    if (!(prop in state)) {
      return undefined;
    }

    if (prop.startsWith('_') || typeof state[prop] === 'function') {
      return Reflect.get(...arguments);
    }

    if (Array.isArray(state[prop])) {
      return new List(state._state, state?._path?.concat(prop) || [prop]);
    }

    if (typeof state[prop] === 'object') {
      const _path = state._path || [];
      _path.push(prop);
      return new Proxy(
        {_state: state._state, _path, ...state[prop]},
        stateHooks
      );
    }

    return state._state.get(prop);
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

class Spirit {
  _state = new Shredder();
  _immState;

  toJS() {
    return this._state.toJS();
  }
}
Elf.Spirit = Spirit;

module.exports = Elf;
