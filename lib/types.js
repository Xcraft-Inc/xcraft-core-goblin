const {
  Type,
  string,
  enumeration,
  record,
  array,
  option,
} = require('xcraft-core-stones');

class ChunkShape {
  chunk = string;
  embedding = array;
}

class MetaShape {
  index = option(string);
  status = enumeration('published', 'trashed', 'archived');
  vectors = option(record(string, ChunkShape));
}

/**
 * @template T
 * @typedef {import("xcraft-core-stones").t<T>} t
 */
/**
 * @typedef {import("xcraft-core-stones").AnyTypeOrShape} AnyTypeOrShape
 */

/**
 * @template {string} T
 * @extends {Type<`${T}@{string}`>}
 */
class IdType extends Type {
  /** @param {T} name */
  constructor(name) {
    super('id');
    this.refName = name;
  }

  get fullName() {
    return `\`${this.refName}@{string}\``;
  }

  /** @type {Type["check"]} */
  check(value, check) {
    if (!check.typeOf(value, 'string')) {
      return;
    }
    check.true(value.startsWith(this.refName + '@'), 'bad pattern', {
      actual: value,
      expectedValues: this.fullName,
    });
  }
}

/** @type {<const T extends string>(name: T) => Type<`${T}@${string}`>} */
const id = (name) => new IdType(name);

module.exports = {
  IdType,
  id,
  MetaShape,
};
