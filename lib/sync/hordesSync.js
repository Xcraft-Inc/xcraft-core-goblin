const watt = require('gigawatts');
const goblinConfig = require('xcraft-core-etc')().load('xcraft-core-goblin');
const Goblin = require('xcraft-core-goblin');

class HordesSync {
  #socketLost;
  #resp;

  constructor() {
    const busClient = require('xcraft-core-busclient').getGlobal();

    this.#resp = busClient.newResponse('elf', 'token');
    this.#resp.events.subscribe('greathall::<perf>', (msg) =>
      this.#monitorPerf(this.#resp, msg.data)
    );

    watt.wrapAll(this, 'sync');
  }

  #monitorPerf(resp, data) {
    const {
      horde, // appId
      delta, // ms now <-> last connect
      lag, // true delta > 1s
      overlay, // true delta > 10s need display overlay
      noSocket, // true if no more socket available
      syncing,
    } = data;

    /* skip because it's not related to socket changes */
    if (syncing) {
      return;
    }

    resp.log.dbg(
      `H=${horde} d=${delta} lag?${lag} noSocket=${noSocket} syncing=${syncing}`
    );
    if (noSocket) {
      this.#socketLost = true;
    }
    if (!noSocket && (this.#socketLost || this.#socketLost === undefined)) {
      this._syncAll();
      this.#socketLost = false;
    }
  }

  _syncAll() {
    for (const db of Goblin.getAllRipleyDB()) {
      /* fire and forget */
      this.sync(db);
    }
  }

  *sync(db, next) {
    if (goblinConfig.actionsSync?.excludeDB?.includes(db)) {
      return;
    }

    try {
      yield this.#resp.command.send('goblin.ripleyClient', {db}, next);
    } catch (ex) {
      this.#resp.log.warn(ex.message || ex.stack || ex);
    }
  }
}

/** @type {HordesSync} */
let hordesSync;

module.exports = () => {
  if (!hordesSync) {
    hordesSync = new HordesSync();
  }
  return hordesSync;
};
