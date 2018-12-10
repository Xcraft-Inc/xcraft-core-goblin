'use strict';

const path = require('path');
const Goblin = require('./index.js');
const {OrderedMap} = require('immutable');

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
    const goblinId = action.get('goblinId');
    const TTL = state.get(`private.goblins.${goblinId}`, null);
    const value = action.get('value');

    if (value === 0 && TTL !== null) {
      return state
        .del(`private.goblins.${goblinId}`)
        .del(`private.TTLs.${TTL}.${goblinId}`);
    }

    const epoch = getTimestampForTTL(value);

    if (TTL === null) {
      return state
        .set(`private.goblins.${goblinId}`, epoch)
        .set(`private.TTLs.${epoch}.${goblinId}`, true);
    }
    if (TTL !== epoch) {
      return state
        .set(`private.goblins.${goblinId}`, epoch)
        .del(`private.TTLs.${TTL}.${goblinId}`)
        .set(`private.TTLs.${epoch}.${goblinId}`, true);
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
