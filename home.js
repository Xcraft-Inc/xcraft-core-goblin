const UserActor = require('./lib/userActor.js');

/**
 * Retrieve the list of available commands.
 *
 * @returns {Object} The list and definitions of commands.
 */
exports.xcraftCommands = function () {
  return UserActor.Home.configure();
};