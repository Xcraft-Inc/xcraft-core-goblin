'use strict';

const Goblin = require('./lib/index.js');

let routingKey = '$';
try {
  const xHost = require('xcraft-core-host');
  routingKey = xHost.getRoutingKey();
} catch (ex) {
  if (ex.code !== 'MODULE_NOT_FOUND') {
    throw ex;
  }
}

const cmd = {};
const getState = `${routingKey}.getState`;

cmd[getState] = function (msg, resp) {
  let state = null;
  const goblinId = msg.data.goblinId;
  const Goblins = Goblin.getGoblinsRegistry();

  try {
    const namespace = Goblin.getGoblinName(goblinId);
    if (Goblins.has(namespace) && Goblins.get(namespace).has(goblinId)) {
      const goblin = Goblins.get(namespace).get(goblinId);
      state = goblin.isCreated() ? goblin.getState() : null;
    }
  } catch (ex) {
    resp.events.send(`goblin-registry.${getState}.${msg.id}.error`, {
      code: ex.code,
      message: ex.message,
      stack: ex.stack,
    });
  } finally {
    resp.events.send(`goblin-registry.${getState}.${msg.id}.finished`, state);
  }
};

/**
 * Retrieve the list of available commands.
 *
 * @returns {Object} The list and definitions of commands.
 */
exports.xcraftCommands = function () {
  return {
    handlers: cmd,
    rc: {
      [getState]: {
        parallel: true,
        desc: "get goblin's state",
        options: {
          params: {
            required: ['goblinId'],
          },
        },
      },
    },
  };
};
