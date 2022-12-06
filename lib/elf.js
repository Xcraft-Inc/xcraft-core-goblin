'use strict';

const Goblin = require('./index.js');
const {isAsync, isFunction} = require('xcraft-core-utils/lib/js.js');

function getProperties(obj) {
  const props = {
    ...Object.entries(Object.getOwnPropertyDescriptors(obj))
      .filter(([name, handle]) => !isFunction(handle.value))
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

const reserved = ['dispatch', 'do', 'go', 'quest', 'log', 'state', 'user'];

class Me {
  #quest;

  constructor(quest) {
    this.#quest = quest;

    Object.assign(this, quest.me, quest.elf);

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

const directHooks = {
  async apply(target, self, args) {
    let quest;

    if (self instanceof Me) {
      quest = self.quest;
      self = self.quest.elf;
    } else {
      quest = args.shift(1);
    }

    const {name} = target;
    const toCall = self.__proto__.__proto__[name] ?? self.__proto__[name];
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

  /*
  set(object, key, value, proxy) {
    object[key] = value;
    return true;
  },

  get(target, prop, receiver) {
    return Reflect.get(...arguments);
  },
  */
};

const meHooks = {
  apply(target, self, args) {
    const quest = args[0];
    const api = quest.getAPI(quest.goblin.id);
    api._elf = true;
    return api;
  },
};

const forwardHooks = {
  async apply(target, self, args) {
    const {name} = target;
    const goblinName = Elf.goblinName(self.constructor);
    const params = Goblin.getParams(goblinName, name);
    const _args = params.reduce((obj, key, index) => {
      obj[key] = args[index];
      return obj;
    }, {});

    if (name === 'create') {
      self.id = _args.id;
      const api = await self._quest.create(goblinName, _args);
      api._elf = true;
      return api;
    }

    if (name === 'api') {
      self.id = args[0];
      const api = self._quest.getAPI(args[0]);
      api._elf = true;
      return api;
    }

    const api = self._quest.getAPI(self.id);
    api._elf = true;
    return await api[name](_args);
  },
};

class Elf {
  constructor(quest) {
    if (reserved.some((key) => this[key])) {
      throw new Error(
        `Forbidden use of reserved methods or properties; list of keywords: ${reserved.join(
          ', '
        )}`
      );
    }

    if (quest && quest.constructor.name !== 'Quest') {
      quest = quest.quest;
    }

    const hooks = quest ? forwardHooks : directHooks;

    if (quest) {
      this._quest = quest;
    }

    this._me = new Proxy(this._me, meHooks);

    getAllFuncs(this.__proto__, 2)
      .filter((name) => name !== '_me')
      .forEach((name) => {
        this[name] = new Proxy(this[name], hooks);
      });

    return new Proxy(this, hooks);
  }

  static logicState() {
    return {};
  }

  static logicHandlers() {
    return {
      create: (state, action) => state.set('id', action.get('id')),
    };
  }

  static goblinName(derivatedClass) {
    return derivatedClass.name.replace(/^[A-Z]/, (e) => e.toLowerCase());
  }

  static configure(derivatedClass) {
    const goblinName = Elf.goblinName(derivatedClass);

    getAllFuncs(derivatedClass.prototype).forEach((name) => {
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

    return Goblin.configure(
      goblinName,
      derivatedClass.logicState(),
      derivatedClass.logicHandlers(),
      {class: derivatedClass}
    );
  }

  async create(id) {
    return id;
  }

  async api(id) {
    return this;
  }

  _me() {
    return this;
  }

  delete() {}

  // dispatch() {}
  // do() {}
  // go() {}
  // /** @returns {Quest} */
  // get quest() {}
  // get log() {}
  // /** @returns {Shredder} */
  // get state() {}
  // get user() {}
}

module.exports = Elf;
