'use strict';

const path = require('path');
const Goblin = require('../index.js');
const {RankedCache} = require('xcraft-core-utils');

const goblinName = path.basename(module.parent.filename, '.js');

const logicState = {
  private: {
    goblins: {},
    cache: {},
    items: {},
  },
};

const logicHandlers = {
  create: (state, action) => state.set('id', action.get('id')),
  rank: (state, action) => {
    const goblinId = action.goblinId;
    const goblinName = action.goblinName;
    const size = action.size;
    const onOut = action.onOut;

    let cache = state.get(`private.cache.${goblinName}`);

    let item = state.get(`private.items.${goblinId}`);
    if (item) {
      if (!cache) {
        throw new Error(
          'Fatal error where the RankedCache can not be undefined'
        );
      }
      cache.rank(item);
      return state;
    }

    if (!cache) {
      cache = new RankedCache(size);
      cache.on('out', onOut);
    }

    item = cache.rank({goblinId});
    state = state
      .set(`private.cache.${goblinName}`, cache)
      .set(`private.items.${goblinId}`, item);

    return state;
  },
  'del-item': (state, action) => {
    const goblinId = action.goblinId;
    return state.del(`private.items.${goblinId}`);
  },
  update: (state, action) => {
    const goblinId = action.goblinId;
    const currentTimeout = state.get(`private.goblins.${goblinId}`, null);
    const delay = action.delay;
    const timeout = action.timeout;

    if (delay === 0 && currentTimeout !== null) {
      /* Remove timeout entry */
      clearTimeout(currentTimeout);
      return state.del(`private.goblins.${goblinId}`);
    }

    if (!timeout) {
      throw new Error(
        'Fatal error with cache service, timeout can not be null'
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

    return state;
  },
  clear: state => {
    const caches = state.get(`private.cache`);
    for (const cache of caches.values()) {
      cache.clear();
    }
    return state;
  },
};

Goblin.registerQuest(goblinName, 'create', function(quest) {
  quest.do();
  const {store} = quest.goblin;
  quest.goblin.defer(
    quest.sub(`goblin-cache.clear`, () => store.dispatch({type: 'clear'}))
  );
  return quest.goblin.id;
});

Goblin.registerQuest(goblinName, 'clear', function(quest) {
  quest.do();
});

Goblin.registerQuest(goblinName, 'delete', function(quest) {
  quest.do();
});

module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
