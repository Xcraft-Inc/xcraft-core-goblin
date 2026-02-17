'use strict';

const SmartId = require('../smartId.js');
const {
  js: {isFunction},
} = require('xcraft-core-utils');

/**
 * Get the list of own properties of an object.
 *
 * @param {object} obj source object
 * @returns {Array} list of properties
 */
function getProperties(obj) {
  return Object.entries(Object.getOwnPropertyDescriptors(obj))
    .filter(([, handle]) => !isFunction(handle.value))
    .map(([name]) => name);
}

/**
 * Get the list of functions in an object.
 *
 * @param {object} obj source object
 * @param {*} [depth] depth in inheritance
 * @returns {Array} list of functions
 */
function getAllFuncs(obj, depth = 2) {
  const props = new Set();

  for (let i = 0; i < depth; ++i) {
    for (const [name, handle] of Object.entries(
      Object.getOwnPropertyDescriptors(obj)
    )) {
      if (
        name !== 'constructor' &&
        !handle.set &&
        !handle.get &&
        isFunction(handle.value)
      ) {
        props.add(name);
      }
    }
    obj = Object.getPrototypeOf(obj);
  }

  return [...props];
}

/**
 * Throw if a goblin's id is not valid.
 *
 * @param {string} id goblin's id
 * @param {string} goblinName goblin's name
 */
function checkId(id, goblinName) {
  const smartId = new SmartId(id, goblinName);
  if (!smartId.isValid()) {
    throw new Error(
      `You can't create a new '${id}' with the goblin '${goblinName}'`
    );
  }
}

module.exports = {
  getProperties,
  getAllFuncs,
  checkId,
};
