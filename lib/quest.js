'use strict';

const watt = require('gigawatts');
const {v4: uuidV4} = require('uuid');
const busClient = require('xcraft-core-busclient').getGlobal();

const xUtils = require('xcraft-core-utils');
const {jsify} = xUtils.string;
const {isGenerator} = xUtils.js;
const Goblin = require('./index.js');
const {trace} = require('./questTracer.js');

let LAST_API_TIME = {};
let COMMANDS_REGISTRY = {};
let API_REGISTRY = {};

const apiBuilder = (namespace) => {
  Object.keys(COMMANDS_REGISTRY)
    .filter((cmd) => cmd.startsWith(`${namespace}.`))
    .map((cmd) => ({
      cmd: cmd.replace(/^[^.]+\./, ''),
      info: COMMANDS_REGISTRY[cmd].info,
    }))
    .filter(
      // Exclude create and _private calls and take only namespace calls
      (item) =>
        `${namespace}.${item.cmd}`.startsWith(namespace) &&
        !item.cmd.match(/(^create$|^.+\.create$)/)
    )
    .map((item) => {
      return {
        call: jsify(item.cmd.replace(/^[a-z-]+\./, '')),
        questName: item.cmd,
        info: item.info,
      };
    })
    .forEach((item) => {
      if (!API_REGISTRY[namespace]) {
        API_REGISTRY[namespace] = {};
        API_REGISTRY[`_${namespace}`] = item.info;
      }
      API_REGISTRY[namespace][item.call] = (cmd, LAZY_API) =>
        watt(function* (payload) {
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

  _resp.cmd = watt(function* (cmd, args, next) {
    if (arguments.length === 2) {
      next = args;
      args = null;
    }
    return yield Quest._cmd(_resp, cmd, args, caller, questName, next);
  });

  _resp.evt = (customed, payload, appId = null) =>
    Quest._evt(_resp, customed, caller, payload, appId);

  return _resp;
}

class Quest {
  constructor(context, name, msg, resp) {
    this._deferrable = [];
    this._dispatch = context.dispatch;
    this._resp = resp;
    this._log = this._resp.log;
    this._questName = name;
    this._msg = msg;
    this.goblin = context.goblin;

    const evtAPI = new EvtAPI(this);
    this.evt = function (customed, payload, appId = null) {
      return Quest._evt(this.resp, customed, this.goblin.id, payload, appId);
    }.bind(this);
    this.evt.send = evtAPI.send.bind(evtAPI);
    this.evt.full = evtAPI.full.bind(evtAPI);

    const subAPI = new SubAPI(this);
    this.sub = function (topic, handler) {
      return this._sub(this.resp, topic, handler);
    }.bind(this);

    this.sub.local = subAPI.local.bind(subAPI);
    this.sub.localWait = subAPI.localWait.bind(subAPI);
    this.sub.wait = subAPI.wait.bind(subAPI);
    this.sub.callAndWait = subAPI.callAndWait.bind(subAPI);

    // Track possibles goblin state mutations with this var:
    this.hasDispatched = false;

    watt.wrapAll(
      this,
      'createCache',
      'createFor',
      'createNew',
      'createPlugin',
      'createEntity',
      'create',
      'cmd',
      'doSync',
      'kill',
      'loadState',
      'saveState',
      'sysCall',
      'sysCreate',
      'sysKill'
    );
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
    return this.getAPI(this.goblin.id, this.goblin.goblinName, true, false);
  }

  get sys() {
    let syscall = false;
    if (
      !this.goblin.isCreating() &&
      this.goblin.id !== this.goblin.goblinName
    ) {
      syscall = true;
    }
    return this.getAPI(this.goblin.id, this.goblin.goblinName, true, syscall);
  }

  get warehouse() {
    return this.getAPI('warehouse');
  }

  get calledFrom() {
    const {
      data: {_goblinCaller, _goblinCallerQuest},
    } = this.msg;
    return `${_goblinCaller}.${_goblinCallerQuest}`;
  }

  newResponse() {
    const msg = this._msg;
    const routing = {
      router: msg.router,
      originRouter: msg.originRouter,
    };
    return busClient.newResponse(this.goblin.goblinName, 'token', routing);
  }

  respArgs() {
    return {
      moduleName: this.goblin.goblinName,
      orcName:
        this._resp.orcName === 'greathall'
          ? 'greathall@' + this._resp._busClient.getToken()
          : this._resp.orcName,
      caller: this.goblin.id,
      questName: this._questName,
    };
  }

  *createCache(goblinId) {
    if (!goblinId) {
      const xBus = require('xcraft-core-bus');
      goblinId = `goblin-cache@${xBus.getToken()}`;
    }

    const Goblins = Goblin.getGoblinsRegistry();
    if (
      !Goblins.has('goblin-cache') ||
      !Goblins.get('goblin-cache').has(goblinId)
    ) {
      yield this.cmd('goblin-cache.create', {
        id: goblinId,
        desktopId: 'system',
        parent: 'goblin',
        _goblinLegacy: true,
      });
      return true;
    }
    return false;
  }

  respArgsLocal() {
    return {
      moduleName: this.goblin.goblinName,
      orcName: 'greathall',
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
      throw new Error(
        `Missing namespace in createFor('${goblinName}','${goblinId}', ?, {})`
      );
    }

    if (args.id && /\.|\[|\]/.exec(args.id)) {
      throw new Error(`Malformed identifier found: ${args.id}`);
    }

    if (namespace.indexOf('@') !== -1) {
      namespace = namespace.split('@', 1)[0];
    }

    if (!args.desktopId) {
      throw new Error(
        `no desktop id!\nfor create of ${args.id}\nin ${this.goblin.id}.${
          this._questName
        }\nherited:${this.getDesktop(true)}`
      );
    }

    const usesCache = goblinId.startsWith('goblin-cache@');
    if (usesCache) {
      yield this.createCache(goblinId);
    }

    let TTL;
    if (args && args._goblinTTL && usesCache) {
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

  *createEntity(id, properties) {
    const wAPI = this.getAPI('workshop');
    if (!wAPI) {
      throw new Error('quest.createEntity only work with goblin-workshop');
    }
    let entityPayload = null;
    if (properties.entity) {
      entityPayload = properties.entity;
      delete properties.entity;
    }
    yield wAPI.createEntity({
      entityId: id,
      desktopId: this.getDesktop(),
      createFor: this.goblin.id,
      entity: entityPayload,
      properties,
    });
    const api = this.getAPI(id);
    return api;
  }

  *create(namespace, args) {
    return yield this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  *sysCall(questName, questArguments) {
    const namespace = Goblin.getGoblinName(this.goblin.id);
    let desktopId = this.getDesktop(true);
    if (questArguments && questArguments.desktopId) {
      desktopId = questArguments.desktopId;
    }
    if (!desktopId) {
      throw {
        code: 'SILENT_HILL',
        message: `syscall canceled: ${namespace}.${questName}, no desktopId`,
      };
    }

    if (
      !this.goblin.isCreating() &&
      this.goblin.id !== this.goblin.goblinName
    ) {
      return yield this.cmd('goblin.sysCall', {
        id: 'goblin',
        desktopId,
        goblinId: this.goblin.id,
        namespace,
        questName,
        questArguments,
      });
    } else {
      return yield this.cmd(`${namespace}.${questName}`, {
        id: this.goblin.id,
        desktopId,
        ...questArguments,
      });
    }
  }

  *sysCreate() {
    if (this.goblin.isCreating() || this.goblin.id === this.goblin.goblinName) {
      return;
    }

    let desktopId = this.getDesktop(true);
    if (this.msg.data && this.msg.desktopId) {
      desktopId = this.msg.desktopId;
    }

    yield this.cmd('goblin.sysCreate', {
      id: 'goblin',
      desktopId,
      goblinId: this.goblin.id,
    });
  }

  *sysKill() {
    if (this.goblin.isCreating() || this.goblin.id === this.goblin.goblinName) {
      return;
    }

    let desktopId = this.getDesktop(true);
    if (this.msg.data && this.msg.desktopId) {
      desktopId = this.msg.desktopId;
    }

    yield this.cmd('goblin.sysKill', {
      id: 'goblin',
      desktopId,
      goblinId: this.goblin.id,
    });
  }

  getSystemDesktop() {
    return Goblin.getSystemDesktop(this.getDesktop());
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

  getAPI(id, namespace, withPrivate, autoSysCall) {
    if (!id) {
      throw new Error(`Missing id for getting an API`);
    }

    if (!namespace) {
      namespace = Goblin.getGoblinName(id);
    }

    let cmd;
    let desktopId = this.getDesktop(true);
    if (autoSysCall) {
      cmd = (questName, payload) => {
        if (payload && payload.desktopId) {
          desktopId = payload.desktopId;
        }
        if (!desktopId) {
          throw {
            code: 'SILENT_HILL',
            message: `canceled: ${namespace}.${questName}, no desktopId`,
          };
        }
        return this.cmd(`goblin.sysCall`, {
          id: 'goblin',
          desktopId,
          goblinId: id,
          namespace,
          questName,
          questArguments: payload,
        });
      };
    } else {
      cmd = (questName, payload) =>
        this.cmd(`${namespace}.${questName}`, Object.assign({id}, payload));
    }

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
      .filter((call) => {
        if (!withPrivate) {
          if (call.startsWith('_')) {
            return false;
          }
        }
        return true;
      })
      .map(
        (call) =>
          (LAZY_API[call] = API_REGISTRY[namespace][call](cmd, LAZY_API))
      );
    return LAZY_API;
  }

  getState(goblinId) {
    const Goblins = Goblin.getGoblinsRegistry();
    const namespace = Goblin.getGoblinName(goblinId);
    if (Goblins.has(namespace) && Goblins.get(namespace).has(goblinId)) {
      const goblin = Goblins.get(namespace).get(goblinId);
      if (!goblin.isCreated()) {
        return null;
      }
      return goblin.getState();
    } else {
      return null;
    }
  }

  isAlive(goblinId) {
    const Goblins = Goblin.getGoblinsRegistry();
    const namespace = Goblin.getGoblinName(goblinId);
    if (Goblins.has(namespace) && Goblins.get(namespace).has(goblinId)) {
      const goblin = Goblins.get(namespace).get(goblinId);
      if (!goblin.isCreated()) {
        return false;
      }
      return true;
    } else {
      return false;
    }
  }

  static *_cmd(resp, cmd, args, caller, questName, next) {
    const createQuests = ['.create'];
    if (args && typeof args === 'object') {
      args._goblinInCreate = createQuests.some((q) => cmd.endsWith(q));
      args._goblinCaller = caller;
      args._goblinCallerQuest = questName;
    }
    //trace(caller.split('@', 1)[0], cmd.split('.', 1)[0]);
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

  static _evt(resp, topic, caller, payload, appId = null) {
    if (!payload) {
      payload = {};
    }
    if (payload._isSuperReaper6000) {
      payload = payload.state;
    }
    resp.events.send(
      caller ? `${caller}.${topic}` : topic,
      payload,
      null,
      appId
    );
  }

  hasAPI(namespace) {
    if (namespace.includes('.')) {
      return !!COMMANDS_REGISTRY[namespace];
    }
    const hasCreate = !!COMMANDS_REGISTRY[`${namespace}.create`];
    const hasInit = !!COMMANDS_REGISTRY[`${namespace}.init`];
    return hasCreate || hasInit;
  }

  _sub(resp, topic, handler) {
    let isAsync = false;
    if (isGenerator(handler)) {
      handler = watt(handler);
      isAsync = true;
    }

    const log = this.log;
    const respArgs = this.respArgs();
    return resp.events.subscribe(topic, (msg) => {
      const resp = newResponse(respArgs);
      if (isAsync) {
        return handler(null, {msg, resp}, (err) => {
          if (err) {
            log.err(
              `error with the event "${topic}":\n${
                err.stack || err.message || err
              }`
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

    const payload = {branch: this.goblin.id, data: state};

    const isSingleton = this.goblin.goblinName === this.goblin.id;
    if (isSingleton) {
      payload.parents = this.goblin.id;
    }
    yield this.goblin.upsert(this, payload);
  }

  dispatch(...args) {
    this.hasDispatched = true;
    this._dispatch(...args);
  }

  defer(action) {
    this._deferrable.push(action);
  }

  go(cmd, cmdArgs, delay) {
    if (cmdArgs && cmdArgs.id) {
      if (!this.isAlive(cmdArgs.id)) {
        throw new Error(
          `quest.go() used with a non created instance: ${cmdArgs.id}`
        );
      }
    }
    const run = () =>
      this.evt.send(`<goblin-run>`, {
        calledFrom: this.calledFrom,
        cmd,
        cmdArgs: cmdArgs || {},
      });

    if (delay) {
      const timeoutId = setTimeout(run, delay);
      //cancel func for caller
      return () => clearTimeout(timeoutId);
    } else {
      run();
    }
  }

  release(goblinId) {
    this.resp.events.send(`goblin.released`, {
      id: goblinId,
    });
  }

  *kill(ids, parents, feed, next) {
    if (arguments.length === 2) {
      next = parents;
      parents = undefined;
      feed = undefined;
    } else if (arguments.length === 3) {
      next = feed;
      feed = undefined;
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
          feed,
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
    const msg = `${title}\n\n${desc}\nhint:${hint}\nservice:${
      this.goblin.goblinName
    }\nid:${this.goblin.id}\nex:${ex.stack || ex.message || ex}`;

    const desktop = this.getDesktop(true);
    if (desktop && API_REGISTRY['desktop'] && !desktop.startsWith('system@')) {
      const dAPI = this.getAPI(desktop).noThrow();
      const notificationId = `err-notif@${this.goblin.id}`;
      dAPI.addNotification({
        notificationId,
        glyph: 'solid/exclamation-triangle',
        color: 'red',
        message: msg,
      });
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

class EvtAPI {
  constructor(quest) {
    this.quest = quest;
  }

  send(topic, payload, appId = null) {
    this.quest.resp.events.send(
      `${this.quest.goblin.id.replace(/@.*/, '')}.${topic}`,
      payload,
      null,
      appId
    );
  }

  full(topic, payload, appId = null) {
    return Quest._evt(this.quest.resp, topic, null, payload, appId);
  }
}

class SubAPI {
  constructor(quest) {
    this.quest = quest;
    watt.wrapAll(this, 'callAndWait', 'localWait', '_wait', 'wait');
  }

  local(topic, handler) {
    const respArgs = this.quest.respArgsLocal();
    const resp = newResponse(respArgs);
    return this.quest._sub(resp, topic, handler);
  }

  *_wait(resp, respArgs, topic, next) {
    const _next = next.parallel();
    const unsubWait = resp.events.subscribe(topic, (msg) => {
      const resp = newResponse(respArgs);
      return _next(null, {msg, resp});
    });
    try {
      const res = yield next.sync();
      if (res.length > 0) {
        return res[0].msg.data;
      }
    } catch (ex) {
      this.quest.log.err(
        `error with the wait event "${topic}":\n${ex.stack || ex.message || ex}`
      );
    } finally {
      unsubWait();
    }
  }

  *wait(topic) {
    const respArgs = this.quest.respArgs();
    return yield this._wait(this.quest.resp, respArgs, topic);
  }

  *localWait(topic) {
    const respArgs = this.quest.respArgsLocal();
    const resp = newResponse(respArgs);
    return yield this._wait(resp, respArgs, topic);
  }

  *callAndWait(call, topic, next) {
    const respArgs = this.quest.respArgs();
    const _next = next.parallel();
    const unsubWait = this.quest.resp.events.subscribe(topic, (msg) => {
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
      this.quest.log.err(
        `error with the callAndWait event "${topic}":\n${
          ex.stack || ex.message || ex
        }`
      );
    } finally {
      unsubWait();
    }
  }
}

watt.wrapAll(Quest, '_cmd');

module.exports = Quest;
