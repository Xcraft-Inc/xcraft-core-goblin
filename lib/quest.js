'use strict';

const watt = require('gigawatts');
const uuidV4 = require('uuid/v4');
const busClient = require('xcraft-core-busclient').getGlobal();

const xUtils = require('xcraft-core-utils');
const {jsify} = xUtils.string;
const {isGenerator} = xUtils.js;

const Goblin = require('./index.js');

let LAST_API_TIME = {};
let COMMANDS_REGISTRY = {};
let API_REGISTRY = {};

const apiBuilder = namespace => {
  Object.keys(COMMANDS_REGISTRY)
    .filter(cmd => cmd.startsWith(`${namespace}.`))
    .map(cmd => ({
      cmd: cmd.replace(/^[^.]+\./, ''),
      info: COMMANDS_REGISTRY[cmd].info,
    }))
    .filter(
      // Exclude create and _private calls and take only namespace calls
      item =>
        `${namespace}.${item.cmd}`.startsWith(namespace) &&
        !item.cmd.match(/(^create$|^.+\.create$)/)
    )
    .map(item => {
      return {
        call: jsify(item.cmd.replace(/^[a-z-]+\./, '')),
        questName: item.cmd,
        info: item.info,
      };
    })
    .forEach(item => {
      if (!API_REGISTRY[namespace]) {
        API_REGISTRY[namespace] = {};
        API_REGISTRY[`_${namespace}`] = item.info;
      }
      API_REGISTRY[namespace][item.call] = (cmd, LAZY_API) =>
        watt(function*(payload) {
          const _payload = arguments.length < 2 ? {} : payload;
          let res;
          try {
            res = yield cmd(item.questName, _payload);
          } catch (ex) {
            if (LAZY_API._noThrow) {
              console.warn(`noThrow enabled: ${ex.stack || ex.message || ex}`);
            } else {
              throw ex;
            }
          }
          return res;
        });
    });
};

function newResponse({moduleName, orcName, caller, questName}) {
  const _resp = busClient.newResponse(moduleName, orcName);

  _resp.cmd = watt(function*(cmd, args, next) {
    if (arguments.length === 2) {
      next = args;
      args = null;
    }
    return yield Quest._cmd(_resp, cmd, args, caller, questName, next);
  });

  _resp.evt = (customed, payload) =>
    Quest._evt(_resp, customed, caller, payload);

  return _resp;
}

const subMethods = {
  'evt.send': function(topic, payload) {
    this.resp.events.send(
      `${this.goblin.id.replace(/@.*/, '')}.${topic}`,
      payload
    );
  },
  'sub.wait': watt(function*(topic, next) {
    const respArgs = this.respArgs();
    const _next = next.parallel();
    const unsubWait = this.resp.events.subscribe(topic, msg => {
      const resp = newResponse(respArgs);
      return _next(null, {msg, resp});
    });
    try {
      const res = yield next.sync();
      if (res.length > 0) {
        return res[0].msg.data;
      }
    } catch (ex) {
      this.log.err(
        `error with the wait event "${topic}":\n${ex.stack || ex.message || ex}`
      );
    } finally {
      unsubWait();
    }
  }),
  'sub.callAndWait': watt(function*(call, topic, next) {
    const respArgs = this.respArgs();
    const _next = next.parallel();
    const unsubWait = this.resp.events.subscribe(topic, msg => {
      const resp = newResponse(respArgs);
      return _next(null, {msg, resp});
    });

    try {
      if (isGenerator(call)) {
        yield* call();
      } else {
        call();
      }

      const res = yield next.sync();
      if (res.length > 0) {
        return res[0].msg.data;
      }
    } catch (ex) {
      this.log.err(
        `error with the callAndWait event "${topic}":\n${ex.stack ||
          ex.message ||
          ex}`
      );
    } finally {
      unsubWait();
    }
  }),
};

class Quest {
  constructor(context, name, msg, resp) {
    this._deferrable = [];
    this._dispatch = context.dispatch;
    this._resp = resp;
    this._log = this._resp.log;
    this._questName = name;
    this._msg = msg;
    this.goblin = context.goblin;

    // Track possibles goblin state mutations with this var:
    this.hasDispatched = false;

    watt.wrapAll(
      this,
      'createFor',
      'createNew',
      'createPlugin',
      'create',
      'cmd',
      'doSync',
      'kill',
      'loadState',
      'saveState'
    );

    // Extend methods with sub-methods
    Object.keys(subMethods).forEach(method => {
      const m = method.split('.');
      this[m[0]][m[1]] = subMethods[method].bind(this);
    });
  }

  get questName() {
    return this._questName;
  }

  get resp() {
    return this._resp;
  }

  get msg() {
    return this._msg;
  }

  get log() {
    return this._resp.log;
  }

  get uuidV4() {
    return uuidV4;
  }

  get me() {
    return this.getAPI(this.goblin.id, this.goblin.goblinName, true);
  }

  get warehouse() {
    return this.getAPI('warehouse');
  }

  respArgs() {
    return {
      moduleName: this.goblin.goblinName,
      orcName: this._resp.orcName,
      caller: this.goblin.id,
      questName: this._questName,
    };
  }

  *createFor(
    goblinName, // TODO: only used for logging, it should be removed
    goblinId,
    namespace,
    args
  ) {
    if (!namespace) {
      throw new Error(`Bad create detected in ${goblinName} missing namespace`);
    }

    if (namespace.indexOf('@') !== -1) {
      namespace = namespace.split('@')[0];
    }

    if (!args.desktopId) {
      throw new Error(`no desktop id !!
      for create of ${args.id}
      in ${this.goblin.id}.${this._questName}
      herited:${this.getDesktop(true)}`);
    }

    let TTL;
    if (args && args._goblinTTL && goblinId.startsWith('goblin-cache@')) {
      TTL = args._goblinTTL;
    } else {
      TTL = 0;
    }

    if (args && args._goblinSchedulingMode) {
      this.goblin.schedulingMode = args._goblinSchedulingMode;
    }

    const id = yield this.cmd(
      `${namespace}.create`,
      Object.assign(
        {
          parent: goblinId,
          _goblinLegacy: true,
          _goblinTTL: TTL,
          _goblinSchedulingMode: this.goblin.schedulingMode,
        },
        args
      )
    );

    if (this.isCanceled(id)) {
      return id;
    }

    return this.getAPI(id, namespace);
  }

  *createNew(namespace, args) {
    if (!args) {
      args = {};
    }
    args.id = `${namespace}@${uuidV4()}`;
    namespace = args.id;
    return yield this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  *createPlugin(namespace, args) {
    if (!args) {
      args = {};
    }
    args.id = `${namespace}@${this.goblin.id}`;
    return yield this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  *create(namespace, args) {
    return yield this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  getSystemDesktop() {
    return `system@${this.getSession()}`;
  }

  getDesktop(canFail) {
    //desktopId in msg.data have priority
    let d = this.msg.data && this.msg.data.desktopId;
    if (!d) {
      //we can look in instance in fallback case... but it's not recommanded...
      d = this.goblin.getX('desktopId');
      if (!d) {
        if (!canFail) {
          throw new Error(`unable to get desktop id in ${this.goblin.id}`);
        }
      }
    }
    return d;
  }

  getSession() {
    return this.getDesktop().split('@')[1];
  }

  getStorage(service, session = null) {
    return this.getAPI(`${service}@${session || this.getSession()}`);
  }

  getAPI(id, namespace, withPrivate) {
    if (!id) {
      throw new Error(`Missing id for getting an API`);
    }

    if (!namespace) {
      namespace = Goblin.getGoblinName(id);
    }

    const cmd = (questName, payload) =>
      this.cmd(`${namespace}.${questName}`, Object.assign({id}, payload));

    if (LAST_API_TIME[namespace] !== this.resp.getCommandsRegistryTime()) {
      COMMANDS_REGISTRY = this.resp.getCommandsRegistry();
      LAST_API_TIME[namespace] = this.resp.getCommandsRegistryTime();
      apiBuilder(namespace);
    }

    if (!API_REGISTRY[namespace]) {
      throw new Error(`Missing module for namespace: ${namespace}`);
    }

    const LAZY_API = {
      id,
      version: API_REGISTRY[`_${namespace}`].version,
      _dontKeepRefOnMe: true,
    };

    LAZY_API.noThrow = () => {
      LAZY_API._noThrow = true;
      return LAZY_API;
    };

    Object.keys(API_REGISTRY[namespace])
      .filter(call => {
        if (!withPrivate) {
          if (call.startsWith('_')) {
            return false;
          }
        }
        return true;
      })
      .map(
        call => (LAZY_API[call] = API_REGISTRY[namespace][call](cmd, LAZY_API))
      );
    return LAZY_API;
  }

  getState(goblinId) {
    const Goblins = Goblin.getGoblinsRegistry();
    const namespace = Goblin.getGoblinName(goblinId);
    if (Goblins.has(namespace) && Goblins.get(namespace).has(goblinId)) {
      return Goblins.get(namespace)
        .get(goblinId)
        .getState();
    } else {
      return null;
    }
  }

  static *_cmd(resp, cmd, args, caller, questName, next) {
    const createQuests = ['.create'];
    if (args && typeof args === 'object') {
      args._goblinInCreate = createQuests.some(q => cmd.endsWith(q));
      args._goblinCaller = caller;
      args._goblinCallerQuest = questName;
    }
    const msg = yield resp.command.nestedSend(cmd, args, next);
    return msg.data;
  }

  /**
   * send a command over bus(yield)
   *
   * @param {string} cmd - command name.
   * @param {Array} args - List of command arguments.
   * @param {function} next - Watt's callback.
   * @returns {Object} the results.
   */
  *cmd(cmd, args, next) {
    if (arguments.length === 2) {
      next = args;
      args = null;
    }
    return yield Quest._cmd(
      this.resp,
      cmd,
      args,
      this.goblin.id,
      this._questName,
      next
    );
  }

  static _evt(resp, customed, caller, payload) {
    if (!payload) {
      payload = {};
    }
    if (payload._isSuperReaper6000) {
      payload = payload.state;
    }
    resp.events.send(`${caller}.${customed}`, payload);
  }

  evt(customed, payload) {
    return Quest._evt(this.resp, customed, this.goblin.id, payload);
  }

  hasAPI(namespace) {
    return !!API_REGISTRY[namespace];
  }

  sub(topic, handler) {
    let isAsync = false;
    if (isGenerator(handler)) {
      handler = watt(handler);
      isAsync = true;
    }

    const log = this.log;
    const respArgs = this.respArgs();
    return this.resp.events.subscribe(topic, msg => {
      const resp = newResponse(respArgs);
      if (isAsync) {
        return handler(null, {msg, resp}, err => {
          if (err) {
            log.err(
              `error with the event "${topic}":\n${err.stack ||
                err.message ||
                err}`
            );
          }
        });
      }
      return handler(null, {msg, resp});
    });
  }

  // The fame' quest.do () shortcut, is injected here
  do(action = {}) {
    action.meta = this.msg.data;
    this.hasDispatched = true;
    // Handle special quest runner private quest.do case
    if (this.questName.startsWith('_$')) {
      return this.goblin._do(this.questName.replace('_$', ''), action);
    } else {
      return this.goblin._do(this.questName, action);
    }
  }

  *doSync(action = {}) {
    this.do(action);
    const state = this.goblin.getState();
    yield this.goblin.upsert(this, {branch: this.goblin.id, data: state});
  }

  dispatch(...args) {
    this.hasDispatched = true;
    this._dispatch(...args);
  }

  defer(func) {
    this._deferrable.push(func);
  }

  release(goblinId) {
    this.resp.events.send(`goblin.released`, {
      id: goblinId,
    });
  }

  *kill(ids, parents, next) {
    if (arguments.length === 2) {
      next = parents;
      parents = null;
    }
    if (ids && !Array.isArray(ids)) {
      ids = [ids];
    }
    if (parents && !Array.isArray(parents)) {
      parents = [parents];
    }
    for (const id of ids) {
      this.warehouse.detachFromParents(
        {
          branch: id,
          parents: parents || [this.goblin.id],
        },
        next.parallel()
      );
    }
    yield next.sync();
  }

  cancel() {
    return {
      _QUEST_CANCELED_: true,
      id: this.goblin.id,
      name: this.goblin.goblinName,
    };
  }

  isCanceled(result) {
    return result && result._QUEST_CANCELED_;
  }

  fail(title, desc, hint, ex) {
    const msg = `${title}

    ${desc}
    hint:
    ${hint}
    service:
    ${this.goblin.goblinName}
    id:
    ${this.goblin.id}
    ex:
    ${ex.stack || ex.message || ex}`;

    const desktop = this.getDesktop(true);
    if (desktop) {
      const dAPI = this.getAPI(desktop).noThrow();
      const notificationId = `err-notif@${this.goblin.id}`;
      dAPI.addNotification({
        notificationId,
        glyph: 'solid/exclamation-triangle',
        color: 'red',
        message: msg,
      });
    } else {
      console.log(msg);
    }
  }

  //////////////////////////////////////////////////////////////////
  ///State save/load
  ///Ripley purpose... not documented, not used for the moment...
  *loadState(next) {
    this.log.verb('Loading state...');
    if (this.goblin.useRipley) {
      this.log.verb('Ripleying...');
      yield this.goblin._ripley.ripley(
        this.goblin.store,
        this.getSession(),
        this.resp.log,
        next
      );
      this.log.verb('Ripleying [done]');
    } else {
      this.log.verb('nothing to Ripley (empty config)');
    }
    this.log.verb('Loading state [done]');
  }

  *saveState() {
    this.log.verb('Saving state...');
    const state = this.goblin.store.getState();
    this.goblin._ripley.saveState(state.ellen.get(this.goblin.goblinName));
    yield this.goblin._ripley.waitForWrites();
    this.log.verb('Saving state [done]');
  }
  ////////////////////////////////////////////////////////////////////
}

watt.wrapAll(Quest, '_cmd');

module.exports = Quest;
