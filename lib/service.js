'use strict';

const path = require('path');
const Goblin = require('./index.js');
const xBus = require('xcraft-core-bus');
const xUtils = require('xcraft-core-utils');
const {computeRipleySteps} = require('./ripleyHelpers.js');

const goblinName = path.basename(module.parent.filename, '.js');

const logicState = {};

const logicHandlers = {};

/* WARNING: this init quest __must not__ use warehouse, because it's possible
 * that the warehouse is initializing in an other process (concurrently).
 */
Goblin.registerQuest(goblinName, '_init', function* (quest, $msg, next) {
  const goblins = Goblin.getGoblinsRegistry();

  /* Multicast is not possible here because this init is called before
   * the connecting to the hordes
   */
  quest.sub(`*::warehouse.released`, async (err, {msg}) => {
    const branches = Object.entries(msg.data)
      .map(([id, generation]) => ({
        name: Goblin.getGoblinName(id),
        id,
        generation,
      }))
      .filter(
        ({name, id}) =>
          goblins.has(name) && goblins.get(name).has(id) && name !== id
      );

    if (!branches.length) {
      return;
    }

    for (const {name, id, generation} of branches) {
      try {
        await quest.cmd(`${name}.delete`, {
          id,
          generation,
          _goblinLegacy: true,
        });
      } catch (ex) {
        const err = ex.stack || ex.message || ex;
        if (ex.code === 'SILENT_HILL') {
          quest.log.warn(err);
        } else {
          quest.log.err(err);
        }
      }
    }
  });

  quest.sub.local(`greathall::<axon-orc-added>`, async (err, {msg}) => {
    if (!xBus.getCommander().isModuleRegistered('warehouse')) {
      return;
    }

    const orcName = msg.data;
    const id = `goblin-orc@${orcName}`;
    await quest.createFor('goblin-orc', 'goblin', id, {
      id,
      desktopId: 'system@goblin-orc',
    });
  });

  quest.sub.local(`greathall::<axon-orc-removed>`, async (err, {msg}) => {
    if (!xBus.getCommander().isModuleRegistered('warehouse')) {
      return;
    }

    const orcName = msg.data;
    const id = `goblin-orc@${orcName}`;
    await quest.kill(id);
  });

  quest.sub.local(`greathall::<goblin-run>`, async (err, {msg, resp}) => {
    const {calledFrom, cmd, cmdArgs} = msg.data;
    try {
      await resp.cmd(cmd, {...cmdArgs});
    } catch (ex) {
      resp.log.err(ex.stack || ex.message || ex);
      throw new Error(
        `quest.go(): error during call\ncalled from: ${calledFrom}\nquest.go('${cmd}', ${JSON.stringify(
          cmdArgs
        )})`
      );
    }
  });

  const xHost = require('xcraft-core-host');
  const {appId} = xHost;
  const appArgs = xHost.appArgs();

  const xEtc = require('xcraft-core-etc')();
  const goblinConfig = xEtc.load('xcraft-core-goblin');

  let syncEnabled = goblinConfig.actionsSync?.enable;
  if (appArgs['disable-actions-sync'] && syncEnabled) {
    goblinConfig.actionsSync.enable = false;
    xEtc.saveRun('xcraft-core-goblin', goblinConfig);
    syncEnabled = false;
  }

  const dbSyncList = new Set(Goblin.getAllRipleyDB());
  quest.goblin.setX('dbSyncList', dbSyncList);

  /* Initialize sync stuff */
  if (syncEnabled) {
    const sync = require('./sync/index.js')();

    quest.sub('*::cryo-db-synced', (err, {msg, rep}) => {
      const {db} = msg.data;
      sync.sync(db);
    });
  }

  const {tribe} = appArgs;
  console.log();
  console.log(yield xUtils.log.graffiti('goblin-core', next));
  console.log();
  console.log(`appId: ${appId} tribe: ${tribe}`);
  if (goblinConfig.actionsSync?.enable) {
    console.log(`Actions sync party started`);
  }
  console.log(`Woooah: ready to deliver ${goblins.size} pointy features!`);
  console.log();
});

Goblin.registerQuest(goblinName, 'cache-clear', function* (quest) {
  const cache = quest.getAPI(`goblin-cache@${xBus.getToken()}`);
  yield cache.clear();
});

/* (1) Actions order must be preserved for the goblins order.
 * The commitId are used in order to compute the range of actions
 * to aggregate.
 *
 * goblinId | commitId          goblins array
 * ---------+---------          -------------
 *     X    |    1              B -- 3,9
 *     A    |    2              A -- 2,5,10
 *     B    |    3              C -- 7,11
 *     X    |    4              X -- 1,4,8,12
 *     A    |    5              C -- 6,13 <-
 *     C    |    6
 *     D    |    7
 *     X    |    8
 *     B    |    9
 *     A    |    10
 *     D    |    11
 *     X    |    12
 *     C    |    13 <-
 *
 * The [13] must be the last. It's the most important position.
 * It means that persist actions that are new on the server must
 * be placed before these persists. It's for this reason that the
 * array loops are in reverse order.
 */

Goblin.registerQuest(goblinName, 'ripleyServer', async function (
  quest,
  db,
  actions,
  commitIds,
  userId,
  $msg
) {
  const systemDesktop = `system@ripley`;
  const goblins = [];
  const goblinsMap = {};
  const msgId = $msg.id.substring(0, 8);
  const logPrefixId = `${userId}/${msgId}/${commitIds?.[0]?.substring(0, 8)}`;
  const dbSyncList = quest.goblin.getX('dbSyncList');

  /* Check for authorized database list */
  if (!dbSyncList.has(db)) {
    throw new Error(`[${logPrefixId}] reject database "${db}"`);
  }

  const cryo = quest.getAPI('cryo');

  // (4) (9)
  await cryo.immediate({db});
  quest.defer(async () => {
    quest.log.info(`[${logPrefixId}] commit for ${db} `);
    await cryo.commit({db});
  });

  quest.log.dbg(
    `[${logPrefixId}] start ripley for ${db} with ${actions.length} user's actions`
  );

  quest.log.info(`[${logPrefixId}] begin for ${db} (locked)`);

  quest.defer(
    async () =>
      await quest.kill(Object.keys(goblinsMap), quest.goblin.id, systemDesktop)
  );

  /* Prepare the goblins list and the actions.
   * Reverse the order in order to insert in order.
   * See section (1) for details.
   */
  for (let i = actions.length - 1; i >= 0; --i) {
    const action = JSON.parse(actions[i].action);
    const {id} = action.meta;

    if (!goblinsMap[id]) {
      const goblin = await quest.create(id, {
        id,
        desktopId: systemDesktop,
      });
      goblinsMap[id] = {goblin, actions: []};
      goblins.push(goblinsMap[id]); /* prefer push (fast) over unshift (slow) */
    }

    goblinsMap[id].actions.unshift(action);
  }
  goblins.reverse(); /* reverse (see above) */

  if (actions.length > 0) {
    quest.log.dbg(`[${logPrefixId}] ${actions.length} goblins created`);
  }

  const bumpCommitCnt = (commitId) => {
    if (!Object.prototype.hasOwnProperty.call(commitCnt, commitId)) {
      commitCnt[commitId] = 0;
    }
    ++commitCnt[commitId];
  };

  /* Run the server special ellen quest which will run actions
   * and replicates the new persist to the clients.
   */
  let persisted = [];
  const persistedMap = {};
  const commitCnt = {};
  let newCommitId = null;

  /* Apply the client non-persist actions to the server actions store
   * of each specified goblin. (6)
   */
  for (const {goblin, actions} of goblins) {
    if (!newCommitId) {
      newCommitId = quest.uuidV4();
    }
    const data = await goblin.$4ellen({
      actions,
      commitId: newCommitId,
    });
    if (data) {
      const {id} = goblin;
      if (!persistedMap[id]) {
        persistedMap[id] = true;
      }
      data.commitId = newCommitId;
      persisted.push({id, data});
      bumpCommitCnt(data.commitId);
    }
  }

  if (goblins.length > 0) {
    quest.log.dbg(`[${logPrefixId}] ${goblins.length} $4ellen called`);
  }

  /* Retrieve persist actions that are missing on the client side.
   * It's a range between the last client persist (maybe undefined if it's
   * the first sync), and the last server commit. (8)
   * The lastCommitId is the newCommitId when a bunch of actions were
   * provided by the client. Otherwise it uses the last server commitId.
   * Note that the different situations can be tricky to reproduce.
   */
  let hasCommitId = false;
  let lastClientCommitId;
  for (const commitId of commitIds) {
    hasCommitId = await cryo.hasCommitId({db, commitId});
    if (hasCommitId) {
      lastClientCommitId = commitId;
      break;
    }
  }
  const fromCommitId = hasCommitId ? lastClientCommitId : undefined;
  let toCommitId = undefined;
  let toInclusive = true; /* if toCommitId must be included in the results for the range */
  if (newCommitId) {
    toCommitId = newCommitId;
    toInclusive = false; /* already in the persisted array (returned to the client) */
  } else {
    /* Retrieve the last commit (server side). (5) */
    const lastCommitId = await cryo.getLastCommitId({db});
    toCommitId = lastCommitId?.commitId;
  }
  if (toCommitId && fromCommitId !== toCommitId) {
    const rangeOfActions = [];
    const id = quest.uuidV4();
    const unsub = quest.sub.local(`*::cryo.range.<${id}>.chunk`, (err, {msg}) =>
      rangeOfActions.push(...msg.data)
    );
    try {
      await cryo.getPersistFromRange({
        db,
        id,
        fromCommitId,
        toCommitId,
        toInclusive /* include or not toCommitId in the results */,
      });
    } finally {
      unsub();
    }

    const fromHex = fromCommitId?.substring(0, 8) || '00000000';
    const toHex = toCommitId?.substring(0, 8) || '00000000';
    quest.log.dbg(
      `[${logPrefixId}] retrieve from ${db}, range ${fromHex}:${toHex} of ${rangeOfActions.length} server's actions`
    );

    if (rangeOfActions) {
      const rPersisted = [];
      for (let i = rangeOfActions.length - 1; i >= 0; --i) {
        const row = rangeOfActions[i];
        const id = `${row.goblin.substring(row.goblin.indexOf('-') + 1)}`;
        if (persistedMap[id]) {
          continue;
        }

        /* It must not be at the end in order to preserve
         * the newCommitId at the end. See section (1)
         * -- we should not use unshift because it's too slow, see below
         */
        rPersisted.push({
          id,
          data: {
            action: row.action,
            commitId: row.commitId,
          },
        });
        bumpCommitCnt(row.commitId);
      }
      /* Here we reverse the array (it's faster that a lot of unshift calls)
       * and we use the concat function in order to merge our both arrays.
       */
      rPersisted.reverse();
      persisted = rPersisted.concat(persisted);
    }
  }

  /* Forward the new persist actions to the client. (10) */
  return {newCommitId, persisted, commitCnt};
});

function sendSyncing(quest, db, horde, isSyncing, progress) {
  const syncing = quest.goblin.getX('networkSyncing') || {};
  Object.assign(syncing, {[db]: {sync: isSyncing, progress}});
  quest.goblin.setX('networkSyncing', syncing);
  quest.resp.events.send('greathall::<perf>', {horde, syncing});
}

/**
 * Wrap the main Ripley call for the server.
 *
 * When a sync takes more than 1 second, then the syncing status
 * is set to true for this database. Sync which take less than 1 second
 * are never reported.
 * @param {*} quest Context
 * @param {string} horde
 * @param {string} db Database
 * @param {*} handler Wrapped async function
 * @param {object} [progress]
 * @returns {*} Handler's results
 */
async function wrapForSyncing(quest, horde, db, handler, progress) {
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

Goblin.registerQuest(goblinName, '_ripleyPrepareSync', async function (
  quest,
  db
) {
  const cryo = quest.getAPI('cryo');

  await cryo.immediate({db});
  quest.defer(async () => await cryo.commit({db}));

  /* Retrieve the last synchronized commit and all non-persist actions
   * between the last sync and now. (2, 1)
   */
  const {stagedActions, commitIds} = await cryo.getDataForSync({db});

  /* Tag new non-persist actions with the zero commitId
   *   00000000-0000-0000-0000-000000000000
   * If everything works fine, the zero commitId will be changed to the
   * effective commitId. Zero tagged commits must not be sent anymore,
   * otherwise it's possible to generate bad duplicated entries.
   */
  if (stagedActions) {
    const rows = stagedActions.map(({rowid}) => rowid);
    if (rows.length) {
      await cryo.prepareDataForSync({db, rows, zero: true});
    }
  }

  return {stagedActions, commitIds};
});

Goblin.registerQuest(goblinName, 'ripleyPersistFromZero', async function (
  quest,
  db,
  goblinIds
) {
  const cryo = quest.getAPI('cryo');
  return await cryo.hasActions({db, goblinIds});
});

Goblin.registerQuest(goblinName, '_ripleyApplyPersisted', async function (
  quest,
  db,
  persisted,
  newCommitId,
  rows
) {
  const systemDesktop = `system@ripley`;
  const cryo = quest.getAPI('cryo');

  quest.defer(
    async () =>
      await quest.kill(
        persisted.map(({id}) => id),
        quest.goblin.id,
        systemDesktop
      )
  );

  const promises = [];

  /* Replay the remote persist action on the client side (the new truth). */
  for (const {id, data} of persisted) {
    const type = id.split('@', 1)[0];
    const ElfClass = Goblin.Elf.getClass(type);

    const elf = await new ElfClass(quest).insertOrCreate(
      id,
      systemDesktop,
      data.action, // raw action (special)
      data.commitId
    );
    if (!elf) {
      continue;
    }

    /* The persist is not fully awaitable, the action can be really persisted
     * after the return of the persist; callAndWait is used in order to be sure
     * that the freeze is done.
     */
    const goblin = `${id.split('@', 1)[0]}-${id}`;
    const prom = quest.sub.localCallAndWait(
      async () => await elf.persist(data.action, data.commitId),
      `*::<${goblin}-${data.commitId}-freezed>`
    );
    promises.push(prom);
  }

  await Promise.all(promises);

  /* Replace the zero commitId by the server commitId. The sync is finished
   * for these actions and everything is successful. (12)
   */
  if (newCommitId && rows?.length) {
    await cryo.updateActionsAfterSync({
      db,
      serverCommitId: newCommitId,
      rows,
    });
  }
});

Goblin.registerQuest(goblinName, 'ripleyCheckForCommitId', async function (
  quest,
  db,
  commitIds
) {
  const cryo = quest.getAPI('cryo');

  /* Test if at least one commitId exists in the database,
   * If it's not the case, the client can be used in order to populate
   * the server side.
   */
  const lastCommitId = await cryo.getLastCommitId({db});
  if (!lastCommitId?.commitId) {
    return true; /* The client will populate the server side */
  }

  for (const commitId of commitIds) {
    /* If the commitId is not known and other commitId already exist,
     * it's like trying to sync with an unrelated database.
     */
    if (await cryo.hasCommitId({db, commitId})) {
      return true;
    }
  }

  return false;
});

Goblin.registerQuest(goblinName, 'ripleyCheckBeforeSync', async function (
  quest,
  db,
  noThrow
) {
  const cryo = quest.getAPI('cryo');

  let commitIds = [];
  try {
    /* Retrieve the last synchronized commit. */
    commitIds = await cryo.getSomeCommitIds({db});
    if (!commitIds.length) {
      return true;
    }
  } catch (ex) {
    if (!noThrow) {
      throw ex;
    }
    quest.log.warn(ex.stack || ex.message || ex);
    return false; /* maybe the database is corrupted */
  }

  let passed = false;
  try {
    /* Check if the server has this commitId too. */
    passed = await quest.cmd('goblin.ripleyCheckForCommitId', {
      _xcraftRPC: true,
      db,
      commitIds,
    });
  } catch (ex) {
    if (!noThrow) {
      throw ex;
    }
    if (ex.code === 'CMD_NOT_AVAILABLE') {
      return true;
    }
  }
  if (!noThrow && !passed) {
    throw new Error(
      `Stop syncing for ${db} where the local commitId ${commitIds?.[0]} is not known by the server`
    );
  }
  return passed;
});

Goblin.registerQuest(goblinName, 'ripleyClient', async function (quest, db) {
  const syncLock = xUtils.locks.getMutex;
  const cryo = quest.getAPI('cryo');
  const {me} = quest;

  const horde = xBus
    .getCommander()
    .getRoutingKeyFromId('goblin.ripleyServer', null, true);

  const shuttingDown = 'ripley.shuttingDown';
  /* The pause is used for the shutdown. Here we prevent a new sync. */
  if (quest.goblin.getX(shuttingDown)) {
    quest.log.dbg(`Ripley is shuttingDown, skip sync for ${db}`);
    return;
  }

  /* While a sync is running, we can't shutdown the client. The counter
   * can be used to know how many syncs are running.
   */
  const thinkData = quest.goblin.getX('ripley.thinking', {});
  thinkData[db] = true;
  quest.defer(() => delete thinkData[db]);

  await syncLock.lock(`ripleyClient-${db}`);
  quest.defer(() => syncLock.unlock(`ripleyClient-${db}`));

  /* The pause is used for the shutdown. Here we prevent a new sync. */
  if (quest.goblin.getX(shuttingDown)) {
    quest.log.dbg(`Ripley is shuttingDown, skip sync for ${db}`);
    return;
  }

  quest.log.info(`start ripley for ${db}`);
  quest.defer(() => quest.log.info(`end of ripley for ${db}`));

  /* Check if a previous sync was interrupted by searching for zero
   * commitId. In this case, we must ask the server for the corresponding
   * persisted actions.
   */
  let zeroRows = [];
  const zeroActions = await cryo.getZeroActions({db});
  if (zeroActions.length) {
    const arePersisted = await quest.cmd('goblin.ripleyPersistFromZero', {
      _xcraftRPC: true,
      db,
      goblinIds: zeroActions.map(({goblin}) => goblin),
    });
    const rows = zeroActions.map(({rowid}) => rowid);
    if (arePersisted) {
      zeroRows = rows;
    } else {
      /* This persist is not known by the server, we must reset the zero commitId */
      await cryo.prepareDataForSync({db, rows, zero: false});
    }
  }

  const {stagedActions, commitIds} = await me._ripleyPrepareSync({db});

  let newCommitId;
  let persisted;
  let commitCnt;
  let rows = stagedActions.map(({rowid}) => rowid);

  // (4) (9)

  try {
    await cryo.immediate({db});
    ({newCommitId, persisted, commitCnt} = await wrapForSyncing(
      quest,
      horde,
      db,
      async () =>
        await quest.cmd('goblin.ripleyServer', {
          _xcraftRPC: true,
          db,
          actions: stagedActions,
          commitIds,
          userId: quest.user.id,
        })
    ));
  } catch (ex) {
    /* Restore zero commitId actions as NULL commitId because the
     * server has failed. These actions must be sent for the next time.
     */
    if (rows.length) {
      await cryo.prepareDataForSync({db, rows, zero: false});
    }
    throw ex;
  } finally {
    await cryo.commit({db});
  }

  if (!commitCnt) {
    quest.log.warn(`Disable Ripley by batch of ~20 actions; old serveur`);
  }

  /* Batch applying of persisted actions in order to commit the changes
   * step by step (~20 actions).
   */
  const steps = computeRipleySteps(persisted, commitCnt);
  for (
    let i = 0, stepIt = 0;
    i < persisted.length;
    i += steps[stepIt], ++stepIt
  ) {
    const start = process.hrtime.bigint();
    const actions = persisted.slice(i, i + steps[stepIt]);

    // (4) (9)

    try {
      await cryo.immediate({db});
      await me._ripleyApplyPersisted({
        db,
        persisted: actions,
        newCommitId: null, // See under
        rows: null, // See under
      });
      await cryo.commit({db});
    } catch (ex) {
      quest.log.err(
        `Rollback ${db} (${persisted.length} actions) because of error`
      );
      await cryo.rollback({db});
      throw ex;
    }

    const end = process.hrtime.bigint();
    quest.log.dbg(
      `ripley for ${db}, replayed actions ${i}:${
        i + steps[stepIt] - 1
      } (total ${persisted.length}) in ${(end - start) / 1_000_000n}ms`
    );
    sendSyncing(quest, db, horde, true, {
      pos: i,
      max: persisted.length,
    });

    if (quest.goblin.getX(shuttingDown)) {
      quest.log.warn(`Stop ${db} syncing because of shutting down`);
      return;
    }
  }

  /* Replace the zero commitId by the server commitId. The sync is finished
   * for these actions and everything is successful. (12)
   */
  rows = rows.concat(zeroRows);
  if (newCommitId && rows?.length) {
    try {
      await cryo.immediate({db});
      await cryo.updateActionsAfterSync({
        db,
        serverCommitId: newCommitId,
        rows,
      });
    } finally {
      await cryo.commit({db});
    }
  }
});

Goblin.registerQuest(goblinName, 'tryShutdown', function* (quest, wait, next) {
  /* Inform the sync stuff that we are shutting down */
  quest.goblin.setX('ripley.shuttingDown', true);

  let thinkData = quest.goblin.getX('ripley.thinking');
  if (!thinkData) {
    return null;
  }

  let databases = Object.keys(thinkData);

  while (wait && databases.length) {
    yield setTimeout(next, 1000);
    thinkData = quest.goblin.getX('ripley.thinking');
    databases = Object.keys(thinkData);
  }

  return {databases};
});

Goblin.registerQuest(goblinName, 'sysCreate', async function (
  quest,
  desktopId,
  goblinId
) {
  const systemFeed = quest.getSystemDesktop();
  await quest.create(goblinId, {
    id: goblinId,
    desktopId: systemFeed,
  });
});

Goblin.registerQuest(goblinName, 'sysKill', async function (
  quest,
  desktopId,
  goblinId
) {
  const systemFeed = quest.getSystemDesktop();
  await quest.kill([goblinId], [quest.goblin.id], systemFeed);
});

Goblin.registerQuest(goblinName, 'sysCall', async function (
  quest,
  desktopId,
  goblinId,
  namespace,
  questName,
  questArguments
) {
  const systemFeed = quest.getSystemDesktop();
  try {
    await quest.create(namespace, {
      id: goblinId,
      desktopId: systemFeed,
    });
    return await quest.cmd(`${namespace}.${questName}`, {
      id: goblinId,
      ...questArguments,
    });
  } finally {
    await quest.kill([goblinId], [quest.goblin.id], systemFeed);
  }
});

Goblin.registerQuest(goblinName, 'status', function (quest) {
  const goblins = Goblin.getGoblinsRegistry();

  quest.log.info(`=================================`);
  quest.log.info(`=== Goblins                   ===`);
  quest.log.info(`=================================`);
  Array.from(goblins.keys())
    .sort()
    .forEach((name) => {
      quest.log.info(`${name}`);
      if (goblins.has(name)) {
        goblins.get(name).forEach((gob) => {
          const feed = JSON.stringify(gob._feed);
          const runningQuests = JSON.stringify(gob._runningQuests);

          quest.log.info(`├─${gob.id}`);
          quest.log.info(`│ ├─ gen:  ${gob._generationId}`);
          quest.log.info(`│ ├─ feed: ${feed}`);
          quest.log.info(`│ ├─ ttl:  ${gob._TTL}`);
          quest.log.info(`│ └─ run:  ${runningQuests}`);
        });
      }
    });
});

Goblin.registerQuest(goblinName, 'getQuestGraph', function (quest) {
  return require('./questTracer.js').graph;
});

Goblin.registerQuest(goblinName, 'xcraftMetrics', function (quest) {
  const os = require('os');
  const xHost = require('xcraft-core-host');
  const tribe = xHost.appArgs().tribe ? `-${xHost.appArgs().tribe}` : '';
  const cmdNamespace = `${xHost.appId}${tribe}`;
  const goblins = Goblin.getGoblinsRegistry();
  const localStorages = Goblin.getSessionsRegistry();
  const metrics = {};

  let numberOfInstances = 0;
  let parallelQueues = 0;
  let immediateQueues = 0;
  let serieQueues = 0;
  let runningQuests = 0;

  for (const [goblinName, services] of goblins) {
    let localStorageKeysTotal = 0;
    for (const [goblinId, service] of services) {
      numberOfInstances++;
      if (
        localStorages.has(goblinName) &&
        localStorages.get(goblinName).has(goblinId)
      ) {
        const localStorage = localStorages.get(goblinName).get(goblinId);

        for (const [, value] of localStorage) {
          let nb = 0;
          if (value) {
            if (Array.isArray(value)) {
              nb = value.length;
            } else if (typeof value === 'object') {
              nb = Object.keys(value).length;
            } else {
              nb = 1;
            }
          }
          localStorageKeysTotal += nb;
        }
      }

      const _metrics = service.metrics;
      if (!_metrics) {
        continue;
      }
      for (const metric in _metrics) {
        metrics[`${os.hostname()}.${cmdNamespace}.${goblinId}.${metric}`] =
          _metrics[metric];
      }

      const scheduler = service.schedulerInfos;
      parallelQueues += scheduler.queue.parallel;
      immediateQueues += scheduler.queue.immediate;
      serieQueues += scheduler.queue.serie;
      runningQuests += Object.values(service._runningQuests).reduce(
        (acc, v) => acc + v,
        0
      );
    }

    metrics[`${os.hostname()}.${cmdNamespace}.${goblinName}.localStorage`] = {
      total: localStorageKeysTotal,
      labels: {appId: cmdNamespace},
    };
  }

  metrics[`${os.hostname()}.${cmdNamespace}.goblinInstances`] = {
    total: numberOfInstances,
    labels: {appId: cmdNamespace},
  };
  metrics[`${os.hostname()}.${cmdNamespace}.scheduler.parallelQueues`] = {
    total: parallelQueues,
    labels: {appId: cmdNamespace, mode: 'parallel'},
  };
  metrics[`${os.hostname()}.${cmdNamespace}.scheduler.immediateQueues`] = {
    total: immediateQueues,
    labels: {appId: cmdNamespace, mode: 'immediate'},
  };
  metrics[`${os.hostname()}.${cmdNamespace}.scheduler.serieQueues`] = {
    total: serieQueues,
    labels: {appId: cmdNamespace, mode: 'serie'},
  };
  metrics[`${os.hostname()}.${cmdNamespace}.runningQuests`] = {
    total: runningQuests,
    labels: {appId: cmdNamespace},
  };

  return metrics;
});

// Singleton
module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
Goblin.createSingle(goblinName);
