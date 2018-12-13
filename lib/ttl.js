'use strict';

const path = require('path');
const Goblin = require('./index.js');
const {Map, OrderedMap} = require('immutable');

const goblinName = path.basename(module.parent.filename, '.js');

const logicState = {
  private: {
    goblins: Map(),
    TTLs: OrderedMap(),
  },
};

const getTimestampForTTL = TTL => {
  if (TTL === 'Infinity') {
    return parseFloat(TTL);
  }
  const now = new Date().getTime();
  return parseFloat(now + TTL);
};

const logicHandlers = {
  create: (state, action) => state.set('id', action.get('id')),
  'update-ttl': (state, action) => {
    const goblinId = action.goblinId;
    const TTL = state.get(`private.goblins.${goblinId}`, null);
    const value = action.value;
    let delTTLs = false;

    if (value === 0 && TTL !== null) {
      /* Remove TTL entry */
      state = state
        .del(`private.goblins.${goblinId}`)
        .del(`private.TTLs._${TTL}.${goblinId}`);
      delTTLs = true;
    } else {
      const epoch = getTimestampForTTL(value);

      if (TTL === null) {
        /* Add new TTL entry */
        state = state
          .set(`private.goblins.${goblinId}`, epoch)
          .set(`private.TTLs._${epoch}.${goblinId}`, true);
      } else if (TTL !== epoch) {
        /* Update TTL entry */
        state = state
          .set(`private.goblins.${goblinId}`, epoch)
          .del(`private.TTLs._${TTL}.${goblinId}`)
          .set(`private.TTLs._${epoch}.${goblinId}`, true);
        delTTLs = true;
      }
    }

    if (delTTLs && state.get(`private.TTLs._${TTL}`).size === 0) {
      /* Clean empty TTL entry */
      state = state.del(`private.TTLs._${TTL}`);
    }

    return state;
  },
};

Goblin.registerQuest(goblinName, 'create', function(quest) {
  quest.do();

  quest.goblin.store.subscribe(state => {});

  return quest.goblin.id;
});

Goblin.registerQuest(goblinName, 'delete', function(quest) {
  quest.do();
});

module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
