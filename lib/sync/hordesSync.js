const watt = require('gigawatts');

class HordesSync {
  #socketLost;
  #dbList = new Set();
  #resp;

  constructor() {
    const busClient = require('xcraft-core-busclient').getGlobal();

    this.#resp = busClient.newResponse('elf', 'token');
    this.#resp.events.subscribe('greathall::<perf>', (msg) =>
      this.#monitorPerf(this.#resp, msg.data)
    );

    watt.wrapAll(this, 'sync', '_syncAll');
  }

  #monitorPerf(resp, data) {
    const {
      horde, // appId
      delta, // ms now <-> last connect
      lag, // true delta > 1s
      overlay, // true delta > 10s need display overlay
      noSocket, // true if no more socket available
    } = data;
    resp.log.dbg(`H=${horde} d=${delta} lag?${lag} noSocket?${noSocket}`);
    if (noSocket) {
      this.#socketLost = true;
    }
    if (!noSocket && (this.#socketLost || this.#socketLost === undefined)) {
      this._syncAll(); /* fire and forget */
      this.#socketLost = false;
    }
  }

  *_syncAll() {
    // C'EST DE LA MERDE, IL FAUT PRENDRE LA LISTE COMPLETE
    for (const db of this.#dbList) {
      yield this.sync(db);
    }
  }

  *sync(db, next) {
    try {
      this.#dbList.add(db);
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
