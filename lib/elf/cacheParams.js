/**
 * Cache quest parameters for future retrievals
 */
class CacheParams {
  #goblins = new Map();
  #params = new Map();

  register(goblinName, questName, params) {
    this.#goblins.set(goblinName, true);
    this.#params.set(`${goblinName}.${questName}`, params);
  }

  get(goblinName, questName) {
    return this.#params.get(`${goblinName}.${questName}`);
  }

  know(goblinName) {
    return this.#goblins.has(goblinName);
  }
}

module.exports = CacheParams;
