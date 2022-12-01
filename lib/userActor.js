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

    if (name === 'create') {
      self.id = args[0].id;
      return await self._quest.create(goblinName, args[0]);
    }

    const goblin = self._quest.getAPI(self.id);
    return await goblin[name](args[0]);
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

  static async create(quest, params) {
    const self = new this(quest);
    return await self.create(params);
  }

  async create(quest, id) {
    return id;
  }

  delete() {}
}

/*************************************************/

class Et extends Elf {
  static configure() {
    return Elf.configure(this);
  }

  async create(id) {
    console.log(`in create for ${id}`);
    this.do();
  }

  /**
   * E.T. wants to phone home
   *
   * @param {String} home - To call home
   */
  async callTo(home) {
    this.log.dbg(`E.T. phone home ${home}`);
    const _home = this.getAPI(home);
    await _home.dring();
  }
}

class Home extends Elf {
  static configure() {
    return Elf.configure(this);
  }

  async create(id) {
    console.log(`in create for ${id}`);
    this.do();
  }

  dring() {
    this.log.dbg('dring dring dring');
  }
}

class Universe extends Elf {
  static configure() {
    return Elf.configure(this);
  }

  async create(id) {
    console.log(`in create for ${id}`);
    this.do();
  }

  async bigbang() {
    const home = await Home.create(this, {
      id: 'home@toto',
      desktopId: 'system@bidon',
    });
    // const home = await Home.create(quest, 'home@toto', 'system@bidon');

    const et = await Et.create(this, {
      id: 'et@toto',
      desktopId: 'system@bidon',
    });

    await et.callTo({home: home.id});
    //await et.call(home.id);
  }
}

/*************************************************/

module.exports = {
  Et,
  Home,
  Universe,
};
