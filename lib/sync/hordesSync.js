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
  }

  get initialized() {
    return this.#initialized;
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

  async _boot(db) {
    if (goblinConfig.actionsSync?.excludeDB?.includes(db)) {
      this._sendSyncing(db, false);
      return;
    }

    let status;
    try {
      let rename = false;

      /* Check if the database exists and if it's the case, check if empty */
      const isEmpty = await this.#resp.command.sendAsync('cryo.isEmpty', {db});
      if (!isEmpty) {
        /* Check if the last commitId is known */
        const passed = await this.#resp.command.sendAsync(
          'goblin.ripleyCheckBeforeSync',
          {db, noThrow: true}
        );
        if (passed) {
          return; /* Skip bootstrap */
        }

        /* Rename the database and bootstrap a new one */
        this.#resp.log.warn(
          `The last commitId for ${db} is not known by the server then bootstrap again`
        );
        rename = true;
      }

      status = setInterval(() => this._sendSyncing(db, true), 1000);

      /* Retrieve all persist actions with an xcraftStream */
      const {xcraftStream, routingKey} = await this.#resp.command.sendAsync(
        'cryo.getAllPersist',
        {
          _xcraftRPC: true,
          db,
        }
      );
      const {streamId} = xcraftStream;

      /* Forward the xcraftStream identifications to the real destination */
      await this.#resp.command.sendAsync('cryo.bootstrapActions', {
        db,
        streamId,
        routingKey,
        rename,
      });
    } catch (ex) {
      this.#resp.log.warn(ex.stack || ex.message || ex);
    } finally {
      clearInterval(status);
      this._sendSyncing(db, false);
    }
  }

  async boot() {
    const promises = [];
    for (const db of Goblin.getAllRipleyDB()) {
      promises.push(this._boot(db));
    }
    await Promise.all(promises);

    this.#initialized = true;
    this.#resp.events.send('goblin.hordesSync-initialized');

    for (const db of Goblin.getAllRipleyDB()) {
      this.sync(db); /* fire and forget */
    }
  }

  async sync(db) {
    if (
      goblinConfig.actionsSync?.excludeDB?.includes(db) ||
      this.#socketLost ||
      !this.#initialized
    ) {
      return;
    }

    try {
      await this.#resp.command.sendAsync('goblin.ripleyClient', {db});
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
