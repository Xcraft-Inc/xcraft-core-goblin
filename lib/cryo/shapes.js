/* eslint-disable jsdoc/require-returns */
// @ts-check
const {
  object,
  dateTime,
  string,
  value,
  number,
  any,
} = require('xcraft-core-stones');

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

class EmbeddingsShape {
  scope = string;
  locale = string;
  documentId = string;
  chunkId = string;
  chunk = string;
  distance = number;
  embedding = any;
}

module.exports = {
  LastPersistedActionShape,
  EmbeddingsShape,
};
