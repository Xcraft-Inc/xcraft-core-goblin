'use strict';

const Goblin = require('./index.js');
const {isAsync} = require('xcraft-core-utils/lib/js.js');

function getAllFuncs(toCheck, depth = 2) {
  let props = {};
  let obj = toCheck;

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

const directHooks = {
  async apply(target, self, args) {
    const {name} = target;

    const toCall = self.__proto__.__proto__[name] ?? self.__proto__[name];

    const quest = args.shift(1);

    if (isAsync(target)) {
      const res = await toCall.bind(quest)(...args);
      if (
        name === 'create' && // TODO delete
        self.__proto__[name] === target &&
        self.__proto__[name] !== self.__proto__.__proto__[name]
      ) {
        await target.bind(quest)(...args);
      }
      return res;
    }

    toCall.bind(quest)(...args);
    if (
      name === 'create' && // TODO delete
      self.__proto__[name] === target &&
      self.__proto__[name] !== self.__proto__.__proto__[name]
    ) {
      return target.bind(quest)(...args);
    }
  },

  set(object, key, value, proxy) {
    object[key] = value;
    console.log('PROXY SET');
    return true;
  },

  /*get(target, prop, receiver) {
    return Reflect.get(...arguments);
  },*/
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

    const api = self._quest.getAPI(self.id);
    api._elf = true;
    return await api[name](_args);
  },
};

class Elf {
  constructor(params) {
    const isDirect = params?._direct;
    const hooks = isDirect ? directHooks : forwardHooks;

    if (params.constructor.name === 'Quest') {
      this._quest = params;
    }

    getAllFuncs(this.__proto__, 2).forEach((name) => {
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

    getAllFuncs(derivatedClass.prototype).forEach((name) =>
      Goblin.registerQuest(goblinName, name, derivatedClass.prototype[name])
    );

    return Goblin.configure(
      goblinName,
      derivatedClass.logicState(),
      derivatedClass.logicHandlers(),
      {class: derivatedClass}
    );
  }

  static async create(quest, ...params) {
    const self = new this(quest);
    return await self.create(...params);
  }

  async create(id) {
    return id;
  }

  delete() {}
}

module.exports = Elf;
