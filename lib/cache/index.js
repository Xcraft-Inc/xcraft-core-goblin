'use strict';

const moduleName = 'goblin-cache';

const watt = require('gigawatts');

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

    const timeout = watt(function*(next) {
      goblinCache.store.dispatch({
        type: 'update',
        goblinId,
        delay: 0,
        timeout: null,
      });
      yield resp.command.nestedSend(
        `warehouse.detach-from-parents`,
        {
          branch: goblinId,
          parents: [`${moduleName}@${xBus.getToken()}`],
        },
        next
      );
    });

    goblinCache.store.dispatch({
      type: 'update',
      goblinId,
      delay: TTL,
      timeout,
    });
  }

  static *rank(goblinName, goblinId, size, next) {
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

    yield resp.command.nestedSend(
      `warehouse.attach-to-parents`,
      {
        branch: goblinId,
        parents: [`${moduleName}@${xBus.getToken()}`],
        feeds: 'system',
      },
      next
    );

    const onOut = watt(function*(item, next) {
      const {goblinId} = item.payload;
      goblinCache.store.dispatch({type: 'del-item', goblinId});
      yield resp.command.nestedSend(
        `warehouse.detach-from-parents`,
        {
          branch: goblinId,
          parents: [`${moduleName}@${xBus.getToken()}`],
        },
        next
      );
    });

    goblinCache.store.dispatch({
      type: 'rank',
      goblinName,
      goblinId,
      size,
      onOut,
    });
  }
}

watt.wrapAll(CacheLib, 'rank');

module.exports = CacheLib;
