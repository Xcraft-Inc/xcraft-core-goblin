class SmartId {
  /** @type {string} */
  id;
  /** @type {string} */
  type;
  /** @type {string} */
  uid;
  /** @type {string} */
  expectedType;

  /**
   * @param {string} id
   * @param {string} expectedType
   */
  constructor(id, expectedType) {
    const [_, type, uid] = id.match(/^([^@]*)@?(.*)$/);
    this.id = id;
    this.type = type;
    this.uid = uid;
    this.expectedType = expectedType;
    return this;
  }

  static #encodeRegex = /[-_.!~*'()]/g;
  static #encodeCharMap = {
    '-': '%2D',
    '_': '%5F',
    '.': '%2E',
    '!': '%21',
    '~': '%7E',
    '*': '%2A',
    "'": '%27',
    '(': '%28',
    ')': '%29',
  };

  static encode(externalId) {
    const id = encodeURIComponent(externalId);
    return id.replace(SmartId.#encodeRegex, (c) => SmartId.#encodeCharMap[c]);
  }

  static decode(id) {
    return decodeURIComponent(id);
  }

  /**
   * @template {string} T
   * @param {T} type
   * @param {string} externalId
   * @param {boolean} [encode=true]
   * @returns {`${T}@${string}`}
   */
  static from(type, externalId, encode = true) {
    return `${type}@${encode ? SmartId.encode(externalId) : externalId}`;
  }

  static toExternalId(id) {
    return SmartId.decode(new SmartId(id, '*').uid);
  }

  static getUid(id) {
    return new SmartId(id, '*').uid;
  }

  isMalformed() {
    return this.isValid() === false;
  }

  isValid() {
    if (this.expectedType === '*') {
      return this.hasUid();
    }
    return this.type === this.expectedType && this.hasUid();
  }

  hasUid() {
    if (!this.uid) {
      return false;
    }
    return true;
  }
}

module.exports = SmartId;
