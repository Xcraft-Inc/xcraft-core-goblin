const goblinConfig = require('xcraft-core-etc')().load('xcraft-core-goblin');
const Goblin = require('xcraft-core-goblin');
const xBus = require('xcraft-core-bus');
const Command = require('xcraft-core-busclient/lib/command.js');
const {setTimeout: setTimeoutAsync} = require('node:timers/promises');
const {locks} = require('xcraft-core-utils');

class HordesSync {
  #initialized = false;
  #initializing = false;
  #socketLost = true;
  #socketLag = false;
  #resp;
  #bootSyncing = {};
  #bootLock = locks.getMutex;

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
      // overlay, // true delta > 10s need display overlay
      noSocket, // true if no more socket available
      syncing,
    } = data;

    /* skip because it's not related to socket changes */
    if (syncing) {
      return;
    }

    resp.log.dbg(`H=${horde} d=${delta} lag=${lag} noSocket=${noSocket}`);
    if (noSocket) {
      this.#socketLost = true;
    } else {
      if (lag && delta >= 30000) {
        this.#socketLag = true;
        Command.abortAll('timeout of 30s');
      } else {
        this.#socketLag = false;
      }
    }

    if (!noSocket && (this.#socketLost || this.#socketLost === undefined)) {
      this.#socketLost = false;
      this._syncAll(true);
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
    try {
      const horde = xBus
        .getCommander()
        .getRoutingKeyFromId('goblin.ripleyServer', null, true);
      Object.assign(this.#bootSyncing, {[db]: {sync: status}});
      this.#resp.events.send('greathall::<perf>', {
        horde,
        syncing: this.#bootSyncing,
      });
    } catch (ex) {
      if (ex.code === 'CMD_NOT_AVAILABLE') {
        this.#resp.log.warn(`Skip syncing for ${db}: ` + ex.message);
      } else {
        this.#resp.log.err(ex.stack || ex.message || ex);
      }
    }
  }

  async _bootstrap(db) {
    let status;
    let empty = true;
    let exists = false;
    let rename = false;

    try {
      await this.#bootLock.lock(`_bootstrap/${db}`);

      try {
        /* Check if the database exists and if it's the case, check if empty */
        const result = await this.#resp.command.sendAsync('cryo.isEmpty', {db});
        if (result) {
          empty = result.empty;
          exists = result.exists;
        }
      } catch (ex) {
        if (ex.code === 'SQLITE_CORRUPT') {
          empty = true;
          exists = false;
          this.#resp.log.err(
            `Database ${db} is corrupted, we need to bootstrap`
          );
        } else {
          throw ex;
        }
      }

      if (!empty) {
        /* Check if the last commitId is known */
        const passed = await this.#resp.command.sendAsync(
          'goblin.ripleyCheckBeforeSync',
          {db, noThrow: true}
        );
        if (passed) {
          return {db, exists, empty}; /* Skip bootstrap */
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

      return {db};
    } catch (ex) {
      if (ex.code === 'CMD_NOT_AVAILABLE') {
        this.#resp.log.warn(`Skip bootstrap for ${db}: ` + ex.message);
      } else {
        this.#resp.log.err(ex.stack || ex.message || ex);
      }
      return {db, exists, empty};
    } finally {
      clearInterval(status);
      this._sendSyncing(db, false);
      this.#bootLock.unlock(`_bootstrap/${db}`);
    }
  }

  _boot(db) {
    if (goblinConfig.actionsSync?.excludeDB?.includes(db)) {
      this._sendSyncing(db, false);
      return;
    }

    this._sendSyncing(db, true);
    return () => this._bootstrap(db);
  }

  async boot() {
    if (this.#initialized || this.#initializing) {
      return true;
    }

    this.#initializing = true;

    try {
      while (true) {
        const boots = [];
        for (const db of Goblin.getAllRipleyDB()) {
          const boot = this._boot(db);
          if (boot) {
            boots.push(boot);
          }
        }

        const results = [];
        for (const boot of boots) {
          results.push(await boot());
        }

        if (results.some((status) => status?.exists === false)) {
          /* Bootstrap mandatory, retry */
          await setTimeoutAsync(1000);
          continue;
        }

        /* Bootstrapped... */
        break;
      }
    } finally {
      this.#initializing = false;
    }

    this.#initialized = true;
    this.#resp.events.send('goblin.hordesSync-initialized');

    for (const db of Goblin.getAllRipleyDB()) {
      this.sync(db); /* fire and forget */
    }
    return true;
  }

  async sync(db) {
    if (
      goblinConfig.actionsSync?.excludeDB?.includes(db) ||
      this.#socketLost ||
      this.#socketLag ||
      !this.#initialized
    ) {
      return;
    }

    try {
      await this.#resp.command.sendAsync('goblin.ripleyClient', {db});
      return true;
    } catch (ex) {
      this.#resp.log.warn(ex.message || ex.stack || ex);
      return false;
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
