/* eslint-disable jsdoc/require-returns */
// @ts-check
const {object, dateTime, string, value, any} = require('xcraft-core-stones');

/**
 * @param {AnyObjectShape} shape
 */
function LastPersistedActionShape(shape) {
  return object({
    goblin: string,
    action: object({
      meta: any,
      payload: object({
        state: shape,
      }),
      type: value('persist'),
    }),
    timestamp: dateTime,
  });
}

module.exports = {
  LastPersistedActionShape,
};
