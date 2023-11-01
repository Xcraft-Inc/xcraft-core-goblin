const watt = require('gigawatts');

class HordesSync {
  #socketLost;
  #dbList = new Map();
  #resp;

  constructor() {
    const busClient = require('xcraft-core-busclient').getGlobal();

    this.#resp = busClient.newResponse('elf', 'token');
    this.#resp.events.subscribe('greathall::<perf>', (msg) =>
      this.#monitorPerf(this.#resp, msg.data)
    );

    watt.wrapAll(this, 'sync', 'syncDB');
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
      this.sync(); /* fire and forget */
      this.#socketLost = false;
    }
  }

  set(db, goblinId) {
    this.#dbList.set(goblinId, db);
  }

  *sync(next) {
    for (const [goblinId, db] of this.#dbList) {
      try {
        const goblinName = goblinId.split('@', 1)[0];
        const goblin = `${goblinName}-${goblinId}`;
        yield this.#resp.command.send('cryo.actionsSync', {db, goblin}, next);
        this.#dbList.delete(db);
      } catch (ex) {
        this.#resp.log.warn(ex.message || ex.stack || ex);
      }
    }
  }

  *syncDB(db, next) {
    try {
      yield this.#resp.command.send('cryo.actionsSyncDB', {db}, next);
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
