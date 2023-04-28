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
  const props = {
    ...Object.entries(Object.getOwnPropertyDescriptors(obj))
      .filter(([, handle]) => !isFunction(handle.value))
      .map(([name]) => name)
      .reduce((out, name) => {
        out[name] = true;
        return out;
      }, {}),
  };
  return Object.keys(props);
}

/**
 * Get the list of functions in an object.
 *
 * @param {object} obj source object
 * @param {*} [depth] depth in inheritance
 * @returns {Array} list of functions
 */
function getAllFuncs(obj, depth = 2) {
  let props = {};

  for (let i = 0; i < depth; ++i) {
    props = {
      ...props,
      ...Object.entries(Object.getOwnPropertyDescriptors(obj))
        .filter(
          ([name, handle]) =>
            name !== 'constructor' &&
            !handle.set &&
            !handle.get &&
            isFunction(handle.value)
        )
        .map(([name]) => name)
        .reduce((out, name) => {
          out[name] = true;
          return out;
        }, {}),
    };
    obj = Object.getPrototypeOf(obj);
  }

  return Object.keys(props);
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
