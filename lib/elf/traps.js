'use strict';

const Shredder = require('xcraft-core-shredder');
const {isAsync} = require('xcraft-core-utils/lib/js.js');
const {isList, isMap} = require('immutable');
const List = require('./list.js');
const utils = require('./utils.js');
const {cacheQuestParams, cacheReduceParams} = require('./params.js');

/////////////////////////////////////////////////////////////////////////////

/**
 * Specific trap to return the Elf logic recucers API
 */
const logicTraps = {
  apply(target, self, args) {
    const params = cacheReduceParams.get(
      self._quest.goblin.goblinName,
      target.name
    );
    const payload = params.reduce((payload, key, index) => {
      if (
        args[index] !== undefined &&
        ((self._quest.msg?.data?.[key] /* do() (not for dispatch()) */ &&
          self._quest.msg?.data?.[key] !== args[index] &&
          args.length > index) ||
        !self._quest.msg?.data?.[key] /* extended arguments */ ||
          self._quest.questName !== target.name) /* dispatch() (not for do()) */
      ) {
        payload[key] = args[index];
      }
      return payload;
    }, {});

    if (target.name === self._quest.questName) {
      self._quest.do(payload);
    } else {
      self._quest.dispatch(target.name, payload);
    }
  },
};

/////////////////////////////////////////////////////////////////////////////

const mapTraps = {
  getOwnPropertyDescriptor(state, prop) {
    if (
      typeof prop === 'symbol' ||
      prop.startsWith('_') ||
      typeof state[prop] === 'function'
    ) {
      return Reflect.getOwnPropertyDescriptor(...arguments);
    }

    const _path = state._path || [];
    const isObj = isMap(state._state.state.getIn(_path));

    return isObj
      ? {enumerable: true, configurable: true}
      : Reflect.getOwnPropertyDescriptor(...arguments);
  },
  ownKeys(state) {
    const _path = state._path || [];
    return Array.from(state._state.state.getIn(_path).keys());
  },
};

/////////////////////////////////////////////////////////////////////////////

/**
 * Traps dedicated to the Elf's reducers.
 */
const stateTraps = {
  get(state, prop) {
    const _path = state._path?.slice() || [];

    /* for..of */
    if (prop === Symbol.iterator) {
      let it;
      const isArray = isList(state._state.state.getIn(_path));
      if (isArray) {
        /* Shoud not be used, because it's wrapper in List */
        it = state._state.state
          .getIn(_path)
          .map((value) => {
            if (!Shredder.isImmutable(value) && !Shredder.isShredder(value)) {
              return value;
            }
            const shredder = new Shredder(value);
            const _value = {
              _state: shredder,
              toJS: shredder.state.toJS.bind(shredder.state.getIn(_path)),
            };
            return new Proxy(_value, stateTraps);
          })
          .values();
      } else {
        it = state._state.state.getIn(_path).entries();
      }
      return it[prop].bind(it);
    }

    if (state instanceof List) {
      const desc = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(state),
        prop
      );
      if (desc?.get) {
        return Reflect.get(...arguments);
      }
    }

    if (
      typeof prop === 'symbol' ||
      prop.startsWith('_') ||
      typeof state[prop] === 'function'
    ) {
      return Reflect.get(...arguments);
    }

    _path.push(prop);
    const isArray = isList(state._state.state.getIn(_path));

    if (isArray) {
      return new Proxy(new List(state._state, _path), stateTraps);
    }

    const isObj = isMap(state._state.state.getIn(_path));
    if (isObj) {
      return new Proxy(
        {
          _state: state._state,
          _path,
          toJS: state._state.getIn(_path).toJS.bind(state._state.getIn(_path)),
          ...state[prop],
        },
        {...stateTraps, ...mapTraps}
      );
    }

    const value = state._state.get(_path);
    if (value?._isSuperReaper6000) {
      return new Proxy(
        {
          _state: state._state,
          _path,
          toJS: state._state.getIn(_path).toJS.bind(state._state.getIn(_path)),
        },
        stateTraps
      );
    }
    return value;
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
    state._state.state.deleteIn(state?._path?.concat(prop) || [prop]);
    return true;
  },
};

/////////////////////////////////////////////////////////////////////////////

const isCreate = (name) => name === 'create' || name === 'init';
const isReserved = (name) => isCreate(name) || name === 'delete';

/**
 * Traps used from the server side (real calls)
 */
const directTraps = {
  async apply(target, self, args) {
    const Me = require('./me.js');

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
    const Elf = require('./index.js');

    let {name} = target;
    const goblinName = Elf.goblinName(self.constructor);

    if (name === 'api') {
      utils.checkId(args[0], goblinName);
      self.id = args[0];
      const api = self.quest.getAPI(args[0]);
      api._elf = true;
      return api;
    }

    let _args;

    if (
      name === 'create' ||
      name === 'insertOrCreate' ||
      name === 'insertOrReplace'
    ) {
      /* map args to object for the create */
      const params = cacheQuestParams.get(goblinName, name);
      _args = params.reduce((obj, key, index) => {
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

      /* insertOrCreate / insertOrReplace */
      if (name !== 'create') {
        // 1. Try quickCreate
        const api = self.quest.getAPI(self.id, self.goblinName, true);
        api._bus = self._bus;
        const {success} = await api[name](_args);
        if (success) {
          return;
        }

        // 2. If unsuccessful, create (with serialized state)
        if (name === 'insertOrReplace') {
          _args._elfInsertOrReplace = true; /* overload the state */
        }
        name = 'create';
      }
    }

    if (name === 'create') {
      let api;
      if (self._createOption) {
        const ttl = self._createOption.ttl;
        if (ttl !== undefined) {
          const xBus = require('xcraft-core-bus');
          _args._goblinTTL = ttl;
          const cmd = `${_args.id.split('@', 1)[0]}.create`;
          const busToken = xBus.getBusTokenFromId(cmd, _args.id);
          api = await self.quest.createFor(
            goblinName,
            `goblin-cache@${busToken}`,
            _args.id,
            _args
          );
        }
      }
      if (!api) {
        //default create
        api = await self.quest.create(goblinName, _args);
      }
      api._elf = true;
      return _args._elfInsertOrReplace ? undefined : api;
    }

    const api = self.quest.getAPI(self.id, self.goblinName, true);
    api._elf = true; /* args are mapped to object by getAPI */
    api._bus = self._bus;
    return await api[name](...args);
  },
};

/////////////////////////////////////////////////////////////////////////////

module.exports = {
  logicTraps,
  mapTraps,
  stateTraps,
  directTraps,
  meTraps,
  forwardTraps,
};
