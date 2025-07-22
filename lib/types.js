const {
  Type,
  string,
  enumeration,
  record,
  option,
  StringType,
} = require('xcraft-core-stones');

class ChunkShape {
  chunk = string;
  embedding = string; //sqlite litteral for blob `X'...'`
}

class MetaShape {
  index = option(string);
  locale = option(string);
  scope = option(string);
  vectors = option(record(string, ChunkShape));
  status = enumeration('published', 'trashed', 'archived');
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
class IdType extends StringType {
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
