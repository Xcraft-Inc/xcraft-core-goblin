'use strict';

const moduleName = 'goblin-cache';

const busClient = require('xcraft-core-busclient').getGlobal();
const xBus = require('xcraft-core-bus');
const Goblin = require('../index.js');

const resp = busClient.newResponse(moduleName, 'token');

class CacheLib {
  static update(goblinId, TTL) {
    const Goblins = Goblin.getGoblinsRegistry();
    const goblinCache = Goblins.get('goblin-cache').get(
      `${moduleName}@${xBus.getToken()}`
    );

    if (!goblinCache) {
      return;
    }

    const timeout = async () => {
      goblinCache.store.dispatch({
        type: 'update',
        goblinId,
        delay: 0,
        timeout: null,
      });
      await resp.command.sendAsync(`warehouse.detach-from-parents`, {
        branch: goblinId,
        parents: [`${moduleName}@${xBus.getToken()}`],
      });
    };

    goblinCache.store.dispatch({
      type: 'update',
      goblinId,
      delay: TTL,
      timeout,
    });
  }

  static async rank(goblinName, goblinId, size, next) {
    if (arguments.length === 3) {
      next = size;
    }

    const Goblins = Goblin.getGoblinsRegistry();
    const goblinCache = Goblins.get('goblin-cache').get(
      `${moduleName}@${xBus.getToken()}`
    );

    if (!goblinCache) {
      return;
    }

    await resp.command.sendAsync(`warehouse.attach-to-parents`, {
      branch: goblinId,
      parents: [`${moduleName}@${xBus.getToken()}`],
      feeds: 'system',
    });

    const onOut = async (item) => {
      const {goblinId} = item.payload;
      goblinCache.store.dispatch({type: 'del-item', goblinId});
      await resp.command.sendAsync(`warehouse.detach-from-parents`, {
        branch: goblinId,
        parents: [`${moduleName}@${xBus.getToken()}`],
        feed: 'system',
      });
    };

    goblinCache.store.dispatch({
      type: 'rank',
      goblinName,
      goblinId,
      size,
      onOut,
    });
  }
}

module.exports = CacheLib;
