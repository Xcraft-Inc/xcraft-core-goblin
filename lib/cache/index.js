'use strict';

const watt = require('gigawatts');

const busClient = require('xcraft-core-busclient').getGlobal();
const xBus = require('xcraft-core-bus');
const Goblin = require('../index.js');

class CacheLib {
  static update(goblinId, TTL) {
    const Goblins = Goblin.getGoblinsRegistry();
    const goblinCache =
      Goblins['goblin-cache'][`goblin-cache@${xBus.getToken()}`];

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
          parents: [`goblin-cache@${xBus.getToken()}`],
        },
        null,
        next,
        [],
        {forceNested: true}
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
    const goblinCache =
      Goblins['goblin-cache'][`goblin-cache@${xBus.getToken()}`];

    yield busClient.command.send(
      `warehouse.attach-to-parents`,
      {
        branch: goblinId,
        parents: [`goblin-cache@${xBus.getToken()}`],
        feeds: 'system',
      },
      null,
      next,
      [],
      {forceNested: true}
    );

    const onOut = watt(function*(item, next) {
      const {goblinId} = item.payload;
      goblinCache.store.dispatch({type: 'del-item', goblinId});
      yield busClient.command.send(
        `warehouse.detach-from-parents`,
        {
          branch: goblinId,
          parents: [`goblin-cache@${xBus.getToken()}`],
        },
        null,
        next,
        [],
        {forceNested: true}
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
