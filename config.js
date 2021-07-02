'use strict';

/**
 * Retrieve the inquirer definition for xcraft-core-etc
 */
module.exports = [
  {
    type: 'confirm',
    name: 'enableCryo',
    message: 'enable action store via Cryo',
    default: false,
  },
  {
    type: 'confirm',
    name: 'enableStateDb',
    message: 'enable action store via StateDb',
    default: false,
  },
  {
    type: 'input',
    name: 'guildsFile',
    message: 'guilds definitions',
    default: 'guildsDef.json',
  },
];
