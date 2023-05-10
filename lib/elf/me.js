'use strict';

const utils = require('./utils.js');

/**
 * Elf wrapper for quest.me
 */
class Me {
  #quest;

  static reserved = [
    'dispatch',
    'do',
    'go',
    'kill',
    'quest',
    'log',
    '_me',
    'state',
    'user',
  ];

  constructor(quest) {
    this.#quest = quest;

    const _me = Object.assign({}, quest.me);
    Me.reserved.forEach((key) => delete _me[key]);
    Object.assign(this, _me, quest.elf);

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
