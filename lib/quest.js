'use strict';

const watt = require('gigawatts');
const {v4: uuidV4} = require('uuid');
const busClient = require('xcraft-core-busclient').getGlobal();
const xHost = require('xcraft-core-host');
const xUtils = require('xcraft-core-utils');
const {jsify} = xUtils.string;
const {isAsync, isGenerator} = xUtils.js;
const Goblin = require('./index.js');
//const {trace} = require('./questTracer.js');

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
        async function (payload = {}) {
          if (!LAZY_API._elf && arguments.length > 1) {
            throw new Error(`The "next" callback is no longer supported`);
          }
          if (LAZY_API._elf) {
            let params = Goblin.getParams(namespace, item.call);
            if (params === false) {
              /* It's the server side case */
              const {required, optional} = COMMANDS_REGISTRY[
                `${namespace}.${item.call}`
              ].options.params;
              params = required.concat(optional);
            }
            payload = params.reduce((obj, key, index) => {
              /* Special case where the sender must use a xcraftUpload key
               * and the receiver must use a xcraftStream.
               */
              if (key === 'xcraftStream') {
                key = 'xcraftUpload';
              }
              obj[key] = arguments[index];
              return obj;
            }, {});
          }

          if (LAZY_API._bus?.rpc !== undefined) {
            payload._xcraftRPC = LAZY_API._bus.rpc;
          }

          let res;
          try {
            res = await cmd(item.questName, payload);
          } catch (ex) {
            if (LAZY_API._noThrow) {
              console.warn(`noThrow enabled: ${ex.stack || ex.message || ex}`);
            } else {
              throw ex;
            }
          }
          return res;
        };
    });
};

function newResponse({
  moduleName,
  orcName,
  caller,
  questName,
  desktopId,
  user,
}) {
  const _resp = busClient.newResponse(moduleName, orcName, null, {
    _goblinUser: user,
  });
  _resp.msgContext = {_goblinUser: user};

  _resp.cmd = async (cmd, args) => {
    //LEVEL1 INJECTION
    //TODO: check modules
    if (args && args._goblinUser) {
      _resp.msgContext = {_goblinUser: args._goblinUser};
    }
    return await Quest._cmd(_resp, cmd, args, caller, questName, desktopId);
  };

  _resp.evt = (customed, payload, appId = null) => {
    return Quest._evt(_resp, customed, caller, payload, appId);
  };

  return _resp;
}

class Quest {
  constructor(context, name, msg, resp) {
    /** @private */ this._deferrable = [];
    /** @private */ this._dispatch = context.dispatch;
    /** @private */ this._resp = resp;
    /** @private */ this._questName = name;
    /** @private */ this._msg = msg;
    this.goblin = context.goblin;
    if (context.goblin._elfInstance) {
      this.elf = context.goblin._elfInstance;
    }
    this.user = Goblin.identifyUser(msg);
    this.commandRegistry = this._resp.getCommandsNames();

    this.user.canDo = (cmd) => {
      if (!this.commandRegistry[cmd]) {
        return false;
      }
      const rank = this.user.rank;
      if (
        this.commandRegistry[cmd][rank] &&
        this.commandRegistry[cmd][rank] === true
      ) {
        return false;
      }
      return true;
    };

    const evtAPI = new EvtAPI(this);
    this.evt = function (customed, payload, appId = null) {
      return Quest._evt(
        this._newEvtQuestResp(),
        customed,
        this.goblin.id,
        payload,
        appId
      );
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
    this.sub.localCallAndWait = subAPI.localCallAndWait.bind(subAPI);

    // Track possibles goblin state mutations with this var:
    this.hasDispatched = false;
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

  /**
   * @returns {ReturnType<import("xcraft-core-log")>} the logger
   */
  get log() {
    return this._resp.log;
  }

  get uuidV4() {
    return uuidV4;
  }

  get me() {
    return this.goblin._elfInstance
      ? this.elf._me(this)
      : this.getAPI(this.goblin.id, this.goblin.goblinName, true, false);
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

  /** @private */
  _newEvtQuestResp() {
    const msg = this._msg;
    const routing = {
      router: msg.router,
      originRouter: msg.originRouter,
    };

    return busClient.newResponse(this.goblin.goblinName, msg.orcName, routing, {
      _goblinUser: this.user._goblinUser,
    });
  }

  newResponse(routing = null) {
    const msg = this._msg;
    if (!routing) {
      routing = {
        router: msg.router,
        originRouter: msg.originRouter,
      };
    }
    return busClient.newResponse(this.goblin.goblinName, 'token', routing, {
      _goblinUser: this.user._goblinUser,
    });
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
      desktopId: this.getDesktop(true),
      user: this.user._goblinUser,
    };
  }

  async createCache(goblinId) {
    if (arguments.length > 2) {
      throw new Error(
        `Please, remove the 'next' provided as 2th argument when calling createCache for ${goblinId}`
      );
    }

    if (!goblinId) {
      const xBus = require('xcraft-core-bus');
      goblinId = `goblin-cache@${xBus.getToken()}`;
    }

    const Goblins = Goblin.getGoblinsRegistry();
    if (
      !Goblins.has('goblin-cache') ||
      !Goblins.get('goblin-cache').has(goblinId)
    ) {
      await this.cmd('goblin-cache.create', {
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
      desktopId: this.getDesktop(true),
      user: this.user._goblinUser,
    };
  }

  async createFor(
    goblinName, // TODO: only used for logging, it should be removed
    goblinId,
    namespace,
    args
  ) {
    if (arguments.length > 4) {
      throw new Error(
        `Please, remove the 'next' provided as 5th argument when calling createFor for ${namespace}: ${goblinId}`
      );
    }

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
      await this.createCache(goblinId);
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

    if (args && args._goblinView) {
      if (args._goblinView.with && !Array.isArray(args._goblinView.with)) {
        throw new Error('Invalid view.with provided (not an array)');
      }

      if (
        args._goblinView.without &&
        !Array.isArray(args._goblinView.without)
      ) {
        throw new Error('Invalid view.without provided (not an array)');
      }
    }

    const id = await this.cmd(
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

  async createNew(namespace, args = {}) {
    if (arguments.length > 2) {
      throw new Error(
        `Please, remove the 'next' provided as 3th argument when calling createNew for ${namespace}`
      );
    }

    args.id = `${namespace}@${uuidV4()}`;
    namespace = args.id;
    return await this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  async createView(namespace, args, view) {
    if (arguments.length > 3) {
      throw new Error(
        `Please, remove the 'next' provided as 4th argument when calling createView for ${namespace}`
      );
    }

    if (!view || typeof view !== 'object') {
      throw new Error('Invalid view provided');
    }

    if (!args) {
      args = {};
    }
    args.id = `${namespace}@${uuidV4()}`;
    namespace = args.id;
    args._goblinView = {};

    if (view.with) {
      args._goblinView.with = view.with;
    }

    if (view.without) {
      args._goblinView.without = view.without;
    }

    return await this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  async createPlugin(namespace, args = {}) {
    if (arguments.length > 2) {
      throw new Error(
        `Please, remove the 'next' provided as 3th argument when calling createPlugin for ${namespace}`
      );
    }

    args.id = `${namespace}@${this.goblin.id}`;
    return await this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  async createEntity(id, properties, view) {
    if (arguments.length > 3) {
      throw new Error(
        `Please, remove the 'next' provided as 4th argument when calling createEntity for ${id}`
      );
    }

    const wAPI = this.getAPI('workshop');
    if (!wAPI) {
      throw new Error('quest.createEntity only work with goblin-workshop');
    }
    let entityPayload = null;
    if (properties?.entity) {
      entityPayload = properties.entity;
      delete properties.entity;
    }
    await wAPI.createEntity({
      entityId: id,
      desktopId: this.getDesktop(),
      createFor: this.goblin.id,
      entity: entityPayload,
      properties,
      view,
    });
    const api = this.getAPI(id);
    return api;
  }

  async create(namespace, args) {
    if (arguments.length > 3) {
      throw new Error(
        `Please, remove the 'next' provided as 3th argument when calling create for ${namespace}`
      );
    }

    return await this.createFor(
      this.goblin.goblinName,
      this.goblin.id,
      namespace,
      args
    );
  }

  async sysCall(questName, questArguments) {
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
      return await this.cmd('goblin.sysCall', {
        id: 'goblin',
        desktopId,
        goblinId: this.goblin.id,
        namespace,
        questName,
        questArguments,
      });
    } else {
      return await this.cmd(`${namespace}.${questName}`, {
        id: this.goblin.id,
        desktopId,
        ...questArguments,
      });
    }
  }

  async sysCreate() {
    if (this.goblin.isCreating() || this.goblin.id === this.goblin.goblinName) {
      return;
    }

    let desktopId = this.getDesktop(true);
    if (this.msg.data && this.msg.desktopId) {
      desktopId = this.msg.desktopId;
    }

    await this.cmd('goblin.sysCreate', {
      id: 'goblin',
      desktopId,
      goblinId: this.goblin.id,
    });
  }

  async sysKill() {
    if (this.goblin.isCreating() || this.goblin.id === this.goblin.goblinName) {
      return;
    }

    let desktopId = this.getDesktop(true);
    if (this.msg.data && this.msg.desktopId) {
      desktopId = this.msg.desktopId;
    }

    await this.cmd('goblin.sysKill', {
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
      throw new Error(
        `Missing module for namespace: ${namespace}, goblinId: ${id}`
      );
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
      .filter((call) => (!withPrivate && call.startsWith('_') ? false : true))
      .map(
        (call) =>
          (LAZY_API[call] = API_REGISTRY[namespace][call](cmd, LAZY_API))
      );
    return LAZY_API;
  }

  _getLocalState(goblinId) {
    const Goblins = Goblin.getGoblinsRegistry();
    const namespace = Goblin.getGoblinName(goblinId);

    /* Look in the current goblins registry */
    if (Goblins.has(namespace) && Goblins.get(namespace).has(goblinId)) {
      const goblin = Goblins.get(namespace).get(goblinId);
      return goblin.isCreated() ? goblin.getState() : null;
    }
  }

  async getState(goblinId) {
    const state = this._getLocalState(goblinId);
    if (state) {
      return state;
    }

    const totalTribes = xHost.appArgs()['total-tribes'];
    if (!totalTribes) {
      return null;
    }

    /* Look in the other goblins registries */
    const appId = xHost.appId;
    const tribe = xHost.getTribeFromId(goblinId);
    let routingKey = appId;
    if (tribe > 0) {
      routingKey = `${appId}-${tribe}`;
    }

    return await this.cmd(`goblin-registry.${routingKey}.getState`, {goblinId});
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

  static async _cmd(resp, cmd, args, caller, questName, desktopId) {
    const createQuests = ['.create'];
    if (args && typeof args === 'object') {
      args._goblinInCreate = createQuests.some((q) => cmd.endsWith(q));
      args._goblinCaller = caller;
      args._goblinCallerQuest = questName;
      if (!args.desktopId) {
        args.desktopId = desktopId;
      }
    }
    //trace(caller.split('@', 1)[0], cmd.split('.', 1)[0]);
    return await resp.command.sendAsync(cmd, args);
  }

  /**
   * send a command over bus
   *
   * @param {string} cmd - command name.
   * @param {object} [args] - Command arguments.
   * @returns {object} the results.
   */
  async cmd(cmd, args) {
    return await Quest._cmd(
      this.resp,
      cmd,
      args,
      this.goblin.id,
      this._questName,
      this.getDesktop(true)
    );
  }

  static _evt(resp, topic, caller, payload, appId = null) {
    if (!payload) {
      payload = {};
    }
    if (payload._isSuperReaper6000) {
      payload = payload.state;
    }
    return resp.events.send(
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

  /** @private */
  _handleSubError(topic, err) {
    if (!err) {
      return;
    }

    this.log.err(
      `error with the event "${topic}":\n${err.stack || err.message || err}`
    );
  }

  /** @private */
  _sub(resp, topic, handler) {
    let _isWatt = false;
    let _isAsync = false;
    if (isGenerator(handler)) {
      handler = watt(handler);
      _isWatt = true;
    }
    if (isAsync(handler)) {
      _isAsync = true;
    }

    const respArgs = this.respArgs();
    return resp.events.subscribe(topic, (msg) => {
      const resp = newResponse(respArgs);
      if (_isWatt) {
        return handler(null, {msg, resp}, (err) =>
          this._handleSubError(topic, err)
        );
      }
      if (_isAsync) {
        return handler(null, {msg, resp}).catch((err) =>
          this._handleSubError(topic, err)
        );
      }
      return handler(null, {msg, resp});
    });
  }

  // The fame' quest.do () shortcut, is injected here
  do(payload = {}) {
    const meta = this.msg.data;
    this.hasDispatched = true;
    // Handle special quest runner private quest.do case
    if (this.questName.startsWith('_$')) {
      return this.goblin._do(this.questName.replace('_$', ''), payload, meta);
    } else {
      return this.goblin._do(this.questName, payload, meta);
    }
  }

  async doSync(action = {}) {
    this.do(action);
    const state = this.goblin.getState();

    const payload = {branch: this.goblin.id, data: state};

    const isSingleton = this.goblin.goblinName === this.goblin.id;
    if (isSingleton) {
      payload.parents = this.goblin.id;
    }
    await this.goblin.upsert(this, payload);
  }

  dispatch(type, payload, meta, error) {
    if (!meta && this.msg?.data?.id) {
      meta = {
        id: this.msg?.data?.id,
      };
    }
    this.hasDispatched = true;
    this._dispatch(type, payload, meta, error);
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
      this.evt.send(`greathall::<goblin-run>`, {
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

  /** @private */
  async _kill(args) {
    let {ids, parents, feed, ...other} = args;
    if (ids && !Array.isArray(ids)) {
      ids = [ids];
    }
    if (parents && !Array.isArray(parents)) {
      parents = [parents];
    }
    const promises = [];
    for (const id of ids) {
      const payload = {
        branch: id,
        parents: parents || [this.goblin.id],
        feed,
        ...other,
      };
      promises.push(this.warehouse.detachFromParents(payload));
    }
    await Promise.all(promises);
  }

  async kill(ids, parents, feed) {
    return await this._kill({ids, parents, feed});
  }

  cancel() {
    return {
      _QUEST_CANCELED_: true,
      id: this.goblin.id,
      name: this.goblin.goblinName,
    };
  }

  fireAndForget() {
    return {
      _QUEST_FIREANDFORGET_: true,
      id: this.goblin.id,
      name: this.goblin.goblinName,
    };
  }

  isCanceled(result) {
    return result && result._QUEST_CANCELED_;
  }

  /**
   * Try to log the exception for overwatch
   * @param {Error} ex
   * @param {object} [msg] internal usage only
   */
  logCommandError(ex, msg = null) {
    const err = ex.stack || ex.message || ex;
    const errorId = ex.id || msg.id;

    if (!errorId) {
      this.log.err(err);
      return;
    }

    this.log.err({
      id: errorId,
      err,
      goblin: {
        id: this.goblin.id,
        goblin: this.goblin.goblinName,
        quest: this.questName,
        callerGoblin: msg?.data?._goblinCaller,
        callerQuest: msg?.data?._goblinCallerQuest,
      },
      _xcraftOverwatch: true,
    });
  }

  fail(title, desc, hint, ex) {
    const msg = `${title}\n\n${desc}\nhint:${hint}\nservice:${
      this.goblin.goblinName
    }\nid:${this.goblin.id}\nex:${ex.stack || ex.message || ex}`;

    const desktop = this.getDesktop(true);
    if (desktop && API_REGISTRY['desktop'] && desktop.startsWith('desktop@')) {
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
}

class EvtAPI {
  constructor(quest) {
    this.quest = quest;
  }

  send(topic, payload, appId = null) {
    this.quest.resp.events.send(
      topic.includes('::')
        ? topic
        : `${this.quest.goblin.id.replace(/@.*/, '')}.${topic}`,
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
    watt.wrapAll(
      this,
      'callAndWait',
      'localCallAndWait',
      'localWait',
      '_callAndWait',
      '_wait',
      'wait'
    );
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

  *_callAndWait(call, resp, respArgs, topic, next) {
    const _next = next.parallel();
    const unsubWait = resp.events.subscribe(topic, (msg) => {
      const resp = newResponse(respArgs);
      return _next(null, {msg, resp});
    });

    try {
      if (isGenerator(call)) {
        yield* call();
      } else if (isAsync(call)) {
        yield call();
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

  *callAndWait(call, topic) {
    const respArgs = this.quest.respArgs();
    return yield this._callAndWait(call, this.quest.resp, respArgs, topic);
  }

  *localCallAndWait(call, topic) {
    const respArgs = this.quest.respArgsLocal();
    const resp = newResponse(respArgs);
    return yield this._callAndWait(call, resp, respArgs, topic);
  }
}

module.exports = Quest;
