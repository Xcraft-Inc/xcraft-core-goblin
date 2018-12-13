'use strict';

const path = require('path');
const Goblin = require('./index.js');
const {Map} = require('immutable');

const goblinName = path.basename(module.parent.filename, '.js');

const logicState = {
  private: {
    goblins: Map(),
  },
};

const logicHandlers = {
  create: (state, action) => state.set('id', action.get('id')),
  'update-ttl': (state, action) => {
    const goblinId = action.goblinId;
    const currentTimeout = state.get(`private.goblins.${goblinId}`, null);
    const delay = action.delay;
    const timeout = action.timeout;

    if (delay === 0 && currentTimeout !== null) {
      /* Remove timeout entry */
      clearTimeout(currentTimeout);
      state = state.del(`private.goblins.${goblinId}`);
    } else {
      if (!timeout) {
        throw new Error(
          'Fatal error with TTL service, timeout can not be null'
        );
      }

      if (currentTimeout) {
        clearTimeout(currentTimeout);
      }

      /* Add or update current timeout entry */
      state = state.set(
        `private.goblins.${goblinId}`,
        setTimeout(timeout, delay)
      );
    }

    return state;
  },
};

Goblin.registerQuest(goblinName, 'create', function(quest) {
  quest.do();
  return quest.goblin.id;
});

Goblin.registerQuest(goblinName, 'delete', function(quest) {
  quest.do();
});

module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
