const watt = require('gigawatts');
const goblinConfig = require('xcraft-core-etc')().load('xcraft-core-goblin');
const Goblin = require('xcraft-core-goblin');
const xBus = require('xcraft-core-bus');

class HordesSync {
  #initialized = false;
  #socketLost = true;
  #resp;
  #bootSyncing = {};

  constructor() {
    const busClient = require('xcraft-core-busclient').getGlobal();

    this.#resp = busClient.newResponse('elf', 'token');
    this.#resp.events.subscribe('greathall::<perf>', (msg) =>
      this.#monitorPerf(this.#resp, msg.data)
    );

    watt.wrapAll(this);
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

    resp.log.dbg(`H=${horde} d=${delta} lag?${lag} noSocket=${noSocket}`);
    if (noSocket) {
      this.#socketLost = true;
    }
    if (!noSocket && (this.#socketLost || this.#socketLost === undefined)) {
      this.#socketLost = false;
      this._syncAll();
    }
  }

  _syncAll() {
    if (!this.#initialized) {
      this.boot(); /* fire and forget */
      return;
    }

    for (const db of Goblin.getAllRipleyDB()) {
      /* fire and forget */
      this.sync(db);
    }
  }

  _sendSyncing(db, status) {
    const horde = xBus
      .getCommander()
      .getRoutingKeyFromId('goblin.ripleyServer', null, true);
    Object.assign(this.#bootSyncing, {[db]: status});
    this.#resp.events.send('greathall::<perf>', {
      horde,
      syncing: this.#bootSyncing,
    });
  }

  *_boot(db, next) {
    if (goblinConfig.actionsSync?.excludeDB?.includes(db)) {
      this._sendSyncing(db, false);
      return;
    }

    let results;
    let status;
    try {
      /* Check if the database exists and if it's the case, check if empty */
      results = yield this.#resp.command.send('cryo.isEmpty', {db}, next);
      const isEmpty = results.data;
      if (!isEmpty) {
        return; /* Skip bootstrap */
      }

      status = setInterval(() => this._sendSyncing(db, true), 1000);

      /* Retrieve all persist actions with an xcraftStream */
      results = yield this.#resp.command.send(
        'cryo.getAllPersist',
        {_xcraftRPC: true, db},
        next
      );
      const {xcraftStream, routingKey} = results.data;
      const {streamId} = xcraftStream;

      /* Forward the xcraftStream identifications to the real destination */
      yield this.#resp.command.send(
        'cryo.bootstrapActions',
        {db, streamId, routingKey},
        next
      );
    } catch (ex) {
      this.#resp.log.warn(ex.stack || ex.message || ex);
    } finally {
      clearInterval(status);
      this._sendSyncing(db, false);
    }
  }

  *boot() {
    for (const db of Goblin.getAllRipleyDB()) {
      yield this._boot(db);
    }
    this.#initialized = true;
  }

  *sync(db, next) {
    if (
      goblinConfig.actionsSync?.excludeDB?.includes(db) ||
      this.#socketLost ||
      !this.#initialized
    ) {
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
