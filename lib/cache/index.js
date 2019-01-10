'use strict';

const watt = require('gigawatts');

const busClient = require('xcraft-core-busclient').getGlobal();
const Goblin = require('../index.js');

class CacheLib {
  static update(goblinId, TTL) {
    const Goblins = Goblin.getGoblinsRegistry();
    const goblinCache = Goblins['goblin-cache'][`goblin-cache@${process.pid}`];

    const timeout = watt(function*(next) {
      goblinCache.store.dispatch({
        type: 'update',
        goblinId,
        delay: 0,
        timeout: null,
      });
      yield busClient.command.send(
        `warehouse.detach-from-parents`,
        {
          branch: goblinId,
          parents: [`goblin-cache@${process.pid}`],
        },
        null,
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
    const goblinCache = Goblins['goblin-cache'][`goblin-cache@${process.pid}`];

    yield busClient.command.send(
      `warehouse.attach-to-parents`,
      {
        branch: goblinId,
        parents: [`goblin-cache@${process.pid}`],
        feeds: 'system',
      },
      null,
      next
    );

    const onOut = watt(function*(item, next) {
      const {goblinId} = item.payload;
      goblinCache.store.dispatch({type: 'del-item', goblinId});
      yield busClient.command.send(
        `warehouse.detach-from-parents`,
        {
          branch: goblinId,
          parents: [`goblin-cache@${process.pid}`],
        },
        null,
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
