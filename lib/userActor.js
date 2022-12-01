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

const hooks = {
  async apply(target, self, args) {
    const {name} = target;

    const toCall = self.__proto__.__proto__[name] ?? self.__proto__[name];

    if (isAsync(target)) {
      const res = await toCall.apply(self, args);
      if (
        name === 'create' && // TODO delete
        self.__proto__[name] === target &&
        self.__proto__[name] !== self.__proto__.__proto__[name]
      ) {
        await target(...args);
      }
      return res;
    }

    toCall.apply(self, args);
    if (
      name === 'create' && // TODO delete
      self.__proto__[name] === target &&
      self.__proto__[name] !== self.__proto__.__proto__[name]
    ) {
      return target(...args);
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

class Actor {
  constructor() {
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

  static configure(derivatedClass) {
    const goblinName = derivatedClass.name.replace(/^[A-Z]/, (e) =>
      e.toLowerCase()
    );

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

  async create(quest, id) {
    return id;
  }

  delete() {}
}

//Actor.prototype.create = new Proxy(Actor.prototype.create, hooks);

/*************************************************/

module.exports = class UserActor extends Actor {
  static configure() {
    return Actor.configure(this);
  }

  async create(quest, id) {
    console.log(`in create for ${id}`);
    quest.do();
  }

  async maison(quest) {
    quest.log.dbg('E.T. phone home');
    await quest.me.exoplanet();
  }

  exoplanet(quest) {
    quest.log.dbg('dring dring dring');
  }
};

/*
const main = async () => {
  const myActor = new UserActor();
  const id = await myActor.create();
  console.log(id);
  myActor.delete();
  //myActor.toto = 'tata';
};

main().catch(console.error);
*/
