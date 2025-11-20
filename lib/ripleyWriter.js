'use strict';

const {Writable} = require('node:stream');
const {computeRipleySteps} = require('./ripleyHelpers.js');

const SHUTTING_DOWN_KEY = 'ripley.shuttingDown';

function sendSyncing(quest, db, horde, isSyncing, progress) {
  const syncing = quest.goblin.getX('networkSyncing') || {};
  Object.assign(syncing, {[db]: {sync: isSyncing, progress}});
  quest.goblin.setX('networkSyncing', syncing);
  quest.resp.events.send('greathall::<perf>', {horde, syncing});
}

class CommitCounter {
  #counter = {};

  bump(commitId) {
    if (!Object.prototype.hasOwnProperty.call(this.#counter, commitId)) {
      this.#counter[commitId] = 0;
    }
    ++this.#counter[commitId];
  }

  get counter() {
    return this.#counter;
  }
}

class RipleyWriter extends Writable {
  #quest;
  #db;
  #horde;
  /** @type {CommitCounter} */ #commitCounter;
  #cryo;
  #clientPersisted;
  #persistedSet = new Set();
  #prevPersisted = [];

  constructor(quest, db, horde, clientPersisted) {
    super();
    this.#quest = quest;
    this.#db = db;
    this.#horde = horde;
    this.#commitCounter = new CommitCounter();
    this.#cryo = quest.getAPI('cryo');
    this.#clientPersisted = clientPersisted;

    this.#clientPersisted.forEach(({id, data}) => {
      this.#persistedSet.add(id);
      this.#commitCounter.bump(data.commitId);
    });
  }

  async #applyPersisted(actions) {
    const db = this.#db;

    this.#quest.log.dbg(`ripley for ${db}, begin with ${actions.length}`);
    const start = process.hrtime.bigint();

    // (4) (9)

    try {
      await this.#cryo.immediate({db});
      await this.#quest.me._ripleyApplyPersisted({
        db,
        persisted: actions,
        newCommitId: null, // See under
        rows: null, // See under
      });
      await this.#cryo.commit({db});
    } catch (ex) {
      this.#quest.log.err(
        `Rollback ${db} (${actions.length} actions) because of error`
      );
      await this.#cryo.rollback({db});
      throw ex;
    }

    const end = process.hrtime.bigint();
    this.#quest.log.dbg(
      `ripley for ${db}, replayed actions (total ${actions.length}) in ${
        (end - start) / 1_000_000n
      }ms`
    );
    sendSyncing(this.#quest, db, this.#horde, true, {pos: 0, max: 0});
  }

  async #computeStepsAndApply(persisted) {
    persisted = this.#prevPersisted.concat(persisted);
    this.#prevPersisted = [];

    /* Batch applying of persisted actions in order to commit the changes
     * step by step (~20 actions).
     */
    const steps = computeRipleySteps(persisted, this.#commitCounter.counter);
    for (
      let i = 0, stepIt = 0;
      i < persisted.length;
      i += steps[stepIt], ++stepIt
    ) {
      const actions = persisted.slice(i, i + steps[stepIt]);

      /* It's possible that the last step is truncated because the stream
       * sends fixed width chunks.
       */
      if (stepIt === steps.length - 1) {
        this.#prevPersisted = actions;
        return;
      }

      await this.#applyPersisted(actions);

      if (this.#quest.goblin.getX(SHUTTING_DOWN_KEY)) {
        throw new Error(`Stop ${this.#db} syncing because of shutting down`);
      }
    }
  }

  async _write(actions, encoding, callback) {
    actions = JSON.parse(actions);
    const persisted = actions
      .map((action) => {
        action.id = `${action.goblin.substring(
          action.goblin.indexOf('-') + 1
        )}`;
        delete action.goblin;
        return action;
      })
      .filter(({id}) => !this.#persistedSet.has(id))
      .map(({id, action, commitId}) => {
        this.#commitCounter.bump(commitId);
        return {id, data: {action, commitId}};
      });

    try {
      await this.#computeStepsAndApply(persisted);
      callback();
    } catch (ex) {
      callback(ex);
    }
  }

  async _destroy(err, callback) {
    try {
      const actions = this.#prevPersisted;
      if (!err && actions.length) {
        await this.#applyPersisted(actions);
      }
      callback(err);
    } catch (ex) {
      callback(ex || err);
    } finally {
      sendSyncing(this.#quest, this.#db, this.#horde, false);
    }
  }
}

module.exports = {sendSyncing, RipleyWriter, SHUTTING_DOWN_KEY};
