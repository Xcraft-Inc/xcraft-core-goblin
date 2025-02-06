'use strict';

const utils = require('./utils.js');
const cryoManager = require('../cryo/manager.js');
const goblinConfig = require('xcraft-core-etc')().load('xcraft-core-goblin');
const {logicTraps} = require('./traps.js');

/**
 * Elf wrapper for quest.me
 */
class Me {
  /** @type {import("../quest.js")} */ #quest;
  #sync;

  static reserved = [
    '$create',
    'dispatch',
    'do',
    'go',
    'kill',
    'killFeed',
    'quest',
    'log',
    'logic',
    '_me',
    'persist',
    'state',
    'user',
  ];

  constructor(quest) {
    this.#quest = quest;

    const _me = Object.assign({}, quest.me);
    Me.reserved.forEach((key) => delete _me[key]);
    Object.assign(this, _me, quest.elf);

    if (goblinConfig.actionsSync?.enable && this?._ripley?.persist) {
      this.#sync = require('../sync/index.js')();
    }

    /* Replace properties by getter / setter */
    const props = utils.getProperties(quest.elf);
    props.forEach((prop) => {
      delete this[prop];

      /* Special wrapping in order to return the appropriate
       * goblin's state from this.state in the quests.
       */
      if (prop === 'state') {
        Object.defineProperty(this, prop, {
          get() {
            const state = quest.goblin.getState();
            quest.elf.state = quest.elf._getProxifiedState;
            quest.elf.state._state = state;
            quest.elf.state.toJS = state.toJS.bind(quest.elf.state._state);
            return quest.elf.state;
          },
        });
        return;
      }

      if (prop === 'logic' && quest.elf.logic) {
        if (!this.logic) {
          this.logic = {_quest: quest};
        }

        utils.getAllFuncs(quest.elf.logic.__proto__, 2).forEach((name) => {
          this.logic[name] = new Proxy(quest.elf.logic[name], logicTraps);
        });
        return;
      }

      /* Specific properties defined for the Elf */
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

  get user() {
    return this.#quest.user;
  }

  get cryo() {
    const quest = this.#quest;
    return {
      getState: async (...args) => await cryoManager.getState(quest, ...args),
      getIds: async (...args) => await cryoManager.getIds(quest, ...args),
      reader: async (...args) => await cryoManager.reader(this.#quest, ...args),
      search: async (...args) => await cryoManager.search(this.#quest, ...args),
      searchDistance: async (...args) =>
        await cryoManager.searchDistance(this.#quest, ...args),
      searchRaw: async function* (...args) {
        yield* await cryoManager.searchRaw(quest, ...args);
      },
      queryLastActions: async (...args) =>
        await cryoManager.queryLastActions(quest, ...args),
      pickAction: async (...args) =>
        await cryoManager.pickAction(quest, ...args),
      isPersisted: async (...args) =>
        await cryoManager.isPersisted(quest, ...args),
      isPublished: async (...args) =>
        await cryoManager.isPublished(quest, ...args),
      sync: (db) => this.#sync.sync(db),
    };
  }

  get persist() {
    return async (...args) => {
      if (!this?._ripley?.persist) {
        throw new Error(`"persist" cannot be used without Archetype logic`);
      }
      await this.#quest.me.persist(...args);

      if (goblinConfig.actionsSync?.enable) {
        this.#sync.sync(this._ripley.persist.db);
      }
    };
  }

  async killFeed(feedId, xcraftRPC = false) {
    const payload = {
      feed: feedId,
    };
    if (xcraftRPC) {
      payload._xcraftRPC = true;
    }
    return await this.#quest.warehouse.unsubscribe(payload);
  }

  async kill(ids, parents, feed, xcraftRPC = false) {
    const payload = {
      ids,
      parents,
      feed,
    };
    if (xcraftRPC) {
      payload._xcraftRPC = true;
    }
    return await this.#quest._kill.call(this.#quest, payload);
  }
}

module.exports = Me;
