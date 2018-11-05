'use strict';

const watt = require('watt');
const uuidV4 = require('uuid/v4');

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
    .map(cmd => cmd.replace(/^[^.]+\./, ''))
    .filter(
      // Exclude create and _private calls and take only namespace calls
      questName =>
        `${namespace}.${questName}`.startsWith(namespace) &&
        !questName.match(/(^create$|^.+\.create$|^_.+|\._.+)/)
    )
    .map(questName => {
      return {
        call: jsify(questName.replace(/^[a-z-]+\./, '')),
        questName,
      };
    })
    .forEach(item => {
      if (!API_REGISTRY[namespace]) {
        API_REGISTRY[namespace] = {};
      }
      API_REGISTRY[namespace][item.call] = cmd =>
        watt(function*(payload) {
          const _payload = arguments.length < 2 ? {} : payload;
          return yield cmd(item.questName, _payload);
        });
    });
};

const _send = (topic, payload) => {
  this.resp.events.send(
    `${this.goblin.id.replace(/@.*/, '')}.${topic}`,
    payload
  );
};

const _wait = watt(function*(topic, next) {
  const _next = next.parallel();
  const unsubWait = this.resp.events.subscribe(topic, msg => _next(null, msg));
  const res = yield next.sync();
  unsubWait();
  if (res.length > 0) {
    return res[0].data;
  }
});

class Quest {
  constructor(dispatch, goblin) {
    this._deferrable = [];
    this._dispatch = dispatch;
    this.goblin = goblin;

    // Track possibles goblin state mutations with this var:
    this.hasDispatched = false;

    // Extend methods with sub-methods
    this.evt.send = _send.bind(this);
    this.sub.wait = _wait.bind(this);

    watt.wrapAll(
      this,
      'cmd',
      'kill',
      'createFor',
      'createNew',
      'createPlugin',
      'create',
      'loadState',
      'saveState'
    );
  }

  get questName() {
    return this._questName;
  }

  set questName(questName) {
    this._questName = questName;
  }

  get resp() {
    return this._resp;
  }

  set resp(resp) {
    this._resp = resp;
    this._log = resp.log;
  }

  set msg(msg) {
    this._msg = msg;
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

  defer(func) {
    this._deferrable.push(func);
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
    const msg = yield this.resp.command.send(cmd, args, next);
    return msg.data;
  }

  getAPI(id, namespace) {
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
      _dontKeepRefOnMe: true,
    };

    Object.keys(API_REGISTRY[namespace]).map(
      call => (LAZY_API[call] = API_REGISTRY[namespace][call](cmd))
    );
    return LAZY_API;
  }

  openInventory() {
    const inventory = [];
    return {
      items: inventory,
      getAPI: (id, ns) => {
        console.warn('openInventory().getAPI is deprecated');
        this.getAPI(id, ns);
      },
    };
  }

  get me() {
    return this.getAPI(this.goblin.id, this.goblin.goblinName);
  }

  get warehouse() {
    return this.getAPI('warehouse');
  }

  release(goblinId) {
    this.resp.events.send(`goblin.released`, {
      id: goblinId,
    });
  }

  *kill(ids, owners, next) {
    if (arguments.length === 2) {
      next = owners;
      owners = null;
    }
    if (ids && !Array.isArray(ids)) {
      ids = [ids];
    }
    if (owners && !Array.isArray(owners)) {
      owners = [owners];
    }
    for (const id of ids) {
      this.warehouse.removeCreatedBy(
        {
          owners: owners || [this.goblin.id],
          branch: id,
        },
        next.parallel()
      );
    }
    yield next.sync();
    yield this.warehouse.collect();
  }

  *createFor(
    goblinName, // TODO: only used for logging, it should be removed
    goblinId,
    namespace,
    args
  ) {
    if (!namespace) {
      throw new Error(
        'Bad create detected in ',
        goblinName,
        ' missing namespace'
      );
    }

    if (namespace.indexOf('@') !== -1) {
      namespace = namespace.split('@')[0];
    }

    if (!args.desktopId) {
      args.desktopId = this.getDesktop(true);
    }

    let feed;
    if (args && args._goblinFeed) {
      feed = args._goblinFeed;
    } else {
      const Goblins = Goblin.getGoblinRegistry();
      const ownerName = Goblin.getGoblinName(goblinId);
      if (Goblins[ownerName] && Goblins[ownerName][goblinId]) {
        feed = Goblins[ownerName][goblinId].feed;
      } else {
        feed = this.goblin.feed;
      }
    }

    const id = yield this.cmd(
      `${namespace}.create`,
      Object.assign(
        {
          createdBy: goblinId,
          _goblinLegacy: true,
          _goblinFeed: feed,
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

  getState(goblinId) {
    const Goblins = Goblin.getGoblinRegistry();
    const namespace = Goblin.getGoblinName(goblinId);
    if (Goblins[namespace] && Goblins[namespace][goblinId]) {
      return Goblins[namespace][goblinId].getState();
    } else {
      return null;
    }
  }

  evt(customed, payload) {
    if (!payload) {
      payload = {};
    }
    if (payload._isSuperReaper6000) {
      payload = payload.state;
    }
    this.resp.events.send(`${this.goblin.id}.${customed}`, payload);
  }

  sub(topic, handler) {
    if (isGenerator(handler)) {
      handler = watt(handler);
    }
    return this.resp.events.subscribe(topic, msg => handler(null, msg));
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
      const dAPI = this.getAPI(desktop);
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

  getDesktop(canFail) {
    let d = this.goblin.getX('desktopId');
    if (!d) {
      d = this.msg.data && this.msg.data.desktopId;
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

  getStorage(service) {
    return this.getAPI(`${service}@${this.getSession()}`);
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

  //The fame' quest.do () shortcut, is injected here
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

  dispatch(...args) {
    this.hasDispatched = true;
    this._dispatch(...args);
  }
}

module.exports = Quest;
