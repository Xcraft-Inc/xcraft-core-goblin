'use strict';

const {Writable} = require('node:stream');

const SHUTTING_DOWN_KEY = 'ripley.shuttingDown';

function sendSyncing(quest, db, horde, isSyncing, progress) {
  const syncing = quest.goblin.getX('networkSyncing') || {};
  Object.assign(syncing, {[db]: {sync: isSyncing, progress}});
  quest.goblin.setX('networkSyncing', syncing);
  quest.resp.events.send('greathall::<perf>', {horde, syncing});
}

async function applyPersisted(quest, db, actions, progress) {
  const cryo = quest.getAPI('cryo');
  const start = process.hrtime.bigint();

  // (4) (9)

  try {
    await cryo.immediate({db});
    await quest.me._ripleyApplyPersisted({
      db,
      persisted: actions,
      newCommitId: null, // See under
      rows: null, // See under
    });
    await cryo.commit({db});
  } catch (ex) {
    quest.log.err(
      `Rollback ${db} (${actions.length} actions) because of error`
    );
    await cryo.rollback({db});
    throw ex;
  }

  const end = process.hrtime.bigint();

  const time = (end - start) / 1_000_000n;
  if (progress) {
    const {pos, max} = progress;
    quest.log.dbg(
      `ripley for ${db}, replayed ${actions.length} actions ${pos}/${max} in ${time}ms`
    );
  } else {
    quest.log.dbg(`ripley for ${db}, replayed pending actions in ${time}ms`);
  }
}

/**
 * Wrap the main Ripley call for the server.
 *
 * When a sync takes more than 1 second, then the syncing status
 * is set to true for this database. Sync which take less than 1 second
 * are never reported.
 * @param {*} quest Context
 * @param {string} db Database
 * @param {string} horde
 * @param {*} handler Wrapped async function
 * @param {object} [progress]
 * @returns {*} Handler's results
 */
async function wrapForSyncing(quest, db, horde, handler, progress) {
  let timeout;
  const DELAY = 1000;

  try {
    timeout = setTimeout(() => {
      timeout = null;
      sendSyncing(quest, db, horde, true, progress);
    }, DELAY);

    quest.defer(() => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setTimeout(() => sendSyncing(quest, db, horde, false, progress), DELAY);
    });

    return await handler();
  } catch (ex) {
    if (ex.code === 'CMD_NOT_AVAILABLE') {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    }
    throw ex;
  }
}

/**
 * Compute a list of steps where all actions with the same commitId are
 * never splitted. It concerns ripleyClient, Cryo and the SQLite transactions.
 * In one transaction, all same commitId must be there. It means that a step
 * (a loop) can have more than 100 actions and even less.
 *
 * For example, if the limit is 4 actions by iterate:
 * commitId
 *  A
 *  B
 *  D
 *  D
 *  D ... step 1, with 5 actions
 *  E
 *  F
 *  F
 *  G ... step 2, with 4 actions
 *
 * In this example, the first step will use 5 actions because the last action
 * with the commitId D cannot be in the second iteration.
 * @param {object[]} persisted
 * @param {object} commitCnt
 * @param {number} [limit]
 * @returns {number[]}
 */
function computeRipleySteps(persisted, commitCnt, limit = 20) {
  let steps = [];

  /* Old server */
  if (!commitCnt) {
    return [persisted.length];
  }

  /* Compute all intermediate steps for the main loop */
  const counted = {};
  let step = 0;
  for (const {data} of persisted) {
    const {commitId} = data;
    if (!counted[commitId]) {
      counted[commitId] = 0;
    }
    ++counted[commitId];
    if (counted[commitId] === commitCnt[commitId]) {
      if (step && step + commitCnt[commitId] > limit) {
        steps.push(step);
        step = commitCnt[commitId];
      } else {
        step += commitCnt[commitId];
      }
    }
    if (step >= limit) {
      steps.push(step);
      step = 0;
    }
  }
  if (step > 0) {
    steps.push(step);
    step = 0;
  }

  return steps;
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
  #clientPersisted;
  #persistedSet = new Set();
  #prevPersisted = [];

  #pos = 0;
  #max;

  constructor(quest, db, horde, clientPersisted, max) {
    super();
    this.#quest = quest;
    this.#db = db;
    this.#horde = horde;
    this.#commitCounter = new CommitCounter();
    this.#clientPersisted = clientPersisted;
    this.#max = max;

    this.#clientPersisted.forEach(({id, data}) => {
      this.#persistedSet.add(id);
      this.#commitCounter.bump(data.commitId);
    });
  }

  async #computeStepsAndApply(persisted) {
    /* Provide persisted of the previous iteration */
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
       * See computeRipleySteps for details
       */
      if (stepIt === steps.length - 1) {
        this.#prevPersisted = actions;
        return;
      }

      const progress = {pos: this.#pos, max: this.#max};
      await applyPersisted(this.#quest, this.#db, actions, progress);

      this.#pos += actions.length;
      progress.pos = this.#pos;
      sendSyncing(this.#quest, this.#db, this.#horde, true, progress);

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
      /* Ignore persist already provided by the client */
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
        const progress = {pos: this.#max, max: this.#max};
        await applyPersisted(this.#quest, this.#db, actions, progress);
      }
      callback(err);
    } catch (ex) {
      callback(ex || err);
    } finally {
      sendSyncing(this.#quest, this.#db, this.#horde, false);
    }
  }
}

module.exports = {
  SHUTTING_DOWN_KEY,
  RipleyWriter,
  applyPersisted,
  wrapForSyncing,
  computeRipleySteps,
};
