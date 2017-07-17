'use strict';

const Goblin = require ('.');

/**
 * Retrieve the list of available commands.
 *
 * @returns {Object} The list and definitions of commands.
 */
exports.xcraftCommands = function () {
  return {
    handlers: Goblin.getCommands (),
    rc: {
      status: {
        parallel: true,
        desc: 'show the status of all goblins',
      },
    },
  };
};
