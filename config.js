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
    name: 'actionsSync.enable',
    message: 'enable actions store synchronization for Cryo',
    default: false,
  },
  {
    type: 'list',
    name: 'actionsSync.excludeDB',
    message: 'list of excluded databases from the sync',
    default: [],
  },
  {
    type: 'confirm',
    name: 'enableStateDb',
    message: 'enable action store via StateDb',
    default: false,
  },
  {
    type: 'confirm',
    name: 'enableGuildEnforcerCache',
    message: 'enable the guild enforcer SQLite cache database',
    default: false,
  },
];
