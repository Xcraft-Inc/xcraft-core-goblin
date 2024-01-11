'use strict';

const path = require('path');
const Goblin = require('./index.js');
const xBus = require('xcraft-core-bus');
const xUtils = require('xcraft-core-utils');

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
  quest.sub(`*::warehouse.released`, function* (err, {msg}) {
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
        yield quest.cmd(`${name}.delete`, {
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

  quest.sub.local(`greathall::<axon-orc-added>`, function* (err, {msg}) {
    if (!xBus.getCommander().isModuleRegistered('warehouse')) {
      return;
    }

    const orcName = msg.data;
    const id = `goblin-orc@${orcName}`;
    yield quest.createFor('goblin-orc', 'goblin', id, {
      id,
      desktopId: 'system@goblin-orc',
    });
  });

  const kill = quest.kill;
  quest.sub.local(`greathall::<axon-orc-removed>`, function* (err, {msg}) {
    if (!xBus.getCommander().isModuleRegistered('warehouse')) {
      return;
    }

    const orcName = msg.data;
    const id = `goblin-orc@${orcName}`;
    yield kill(id);
  });

  quest.sub.local(`greathall::<goblin-run>`, function* (err, {msg, resp}) {
    const {calledFrom, cmd, cmdArgs} = msg.data;
    try {
      yield resp.cmd(cmd, {...cmdArgs});
    } catch (ex) {
      throw new Error(`quest.go(): error during call
      called from: ${calledFrom}
      quest.go('${cmd}',${JSON.stringify(cmdArgs)})`);
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
  if (syncEnabled) {
    const sync = require('./sync/index.js')();

    quest.sub('*::cryo-db-synced', (err, {msg, rep}) => {
      const {db} = msg.data;
      sync.sync(db);
    });

    const dbs = Goblin.getAllRipleyDB();
    for (const db of dbs) {
      sync.sync(db);
    }
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

Goblin.registerQuest(goblinName, 'ripleyServer', async function (
  quest,
  db,
  actions,
  lastClientCommitId
) {
  const systemDesktop = `system@ripley`;
  const goblins = {};

  const cryo = quest.getAPI('cryo');

  quest.log.dbg(
    `[${lastClientCommitId}] ripleyServer begin for ${db} with ${actions.length} actions`
  );

  // (4) (9)
  await cryo.immediate({db});
  quest.defer(async () => {
    quest.log.dbg(`[${lastClientCommitId}] ripleyServer commit for ${db} `);
    await cryo.commit({db});
  });

  quest.log.dbg(`[${lastClientCommitId}] ripleyServer locked for ${db}`);

  /* Retrieve the last commit (server side). (5) */
  const lastCommitId = await cryo.getLastCommitId({db});

  quest.defer(
    async () =>
      await quest.kill(Object.keys(goblins), quest.goblin.id, systemDesktop)
  );

  /* Prepare the individual actions */
  for (const {action: actionStr} of actions) {
    const action = JSON.parse(actionStr);
    const goblinId = action.meta.id;
    let goblin;

    if (!goblins[goblinId]) {
      goblin = await quest.create(goblinId, {
        id: goblinId,
        desktopId: systemDesktop,
      });
      goblins[goblinId] = {goblin, actions: []};
    }

    goblins[goblinId].actions.push(action);
  }

  /* Run the server special ellen quest which will run actions
   * and replicates the new persist to the clients.
   */
  const persisted = {};
  let newCommitId = null;

  /* Apply the client non-persist actions to the server actions store
   * of each specified goblin. (6)
   */
  for (const {goblin, actions} of Object.values(goblins)) {
    if (!newCommitId) {
      newCommitId = quest.uuidV4();
    }
    const data = await goblin.$4ellen({
      actions,
      commitId: newCommitId,
    });
    if (data) {
      data.commitId = newCommitId;
      persisted[goblin.id] = data;
    }
  }

  /* Retrieve persist actions that are missing on the client side.
   * It's a range between the last client persist (maybe undefined if it's
   * the first sync), and the last server commit before the bunch of
   * actions "ripleyed" via 4ellen. (8)
   */
  const fromCommitId = lastClientCommitId;
  const toCommitId = lastCommitId?.commitId;
  if (toCommitId && fromCommitId !== toCommitId) {
    const rangeOfActions = await cryo.getPersistFromRange({
      db,
      fromCommitId,
      toCommitId,
    });

    quest.log.dbg(
      `[${fromCommitId}] ripleyServer for ${db}, range ${fromCommitId}:${toCommitId} with ${rangeOfActions.length} actions`
    );

    rangeOfActions?.forEach((row) => {
      const goblinId = `${row.goblin.substring(row.goblin.indexOf('-') + 1)}`;
      if (!persisted[goblinId]) {
        persisted[goblinId] = {
          action: row.action,
          commitId: row.commitId,
        };
      }
    });
  }

  /* Forward the new persist actions to the client. (10) */
  return {newCommitId, persisted};
});

function sendSyncing(quest, db, horde, isSyncing) {
  const syncing = quest.goblin.getX('networkSyncing') || {};
  Object.assign(syncing, {[db]: isSyncing});
  quest.goblin.setX('networkSyncing', syncing);
  quest.resp.events.send('greathall::<perf>', {horde, syncing});
}

/**
 * Wrap the main Ripley call for the server.
 *
 * When a sync takes more than 1 second, then the syncing status
 * is set to true for this database. Sync which take less than 1 second
 * are never reported.
 *
 * @param {*} quest Context
 * @param {string} db Database
 * @param {*} handler Wrapped async function
 * @returns {*} Handler's results
 */
async function wrapForSyncing(quest, db, handler) {
  let timeout;
  const DELAY = 1000;

  try {
    const horde = xBus
      .getCommander()
      .getRoutingKeyFromId('goblin.ripleyServer', null, true);

    timeout = setTimeout(() => {
      timeout = null;
      sendSyncing(quest, db, horde, true);
    }, DELAY);

    quest.defer(() => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setTimeout(() => sendSyncing(quest, db, horde, false), DELAY);
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
  const {stagedActions, lastCommitId} = await cryo.getDataForSync({db});

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

  return {stagedActions, lastCommitId};
});

Goblin.registerQuest(goblinName, 'ripleyPersistFromZero', async function (
  quest,
  db,
  goblinIds
) {
  const cryo = quest.getAPI('cryo');
  const actions = await cryo.getActionsByIds({db, goblinIds});
  return actions.reduce((persist, row) => {
    const goblinId = row.goblin.substring(row.goblin.indexOf('-') + 1);
    persist[goblinId] = row;
    return persist;
  }, {});
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
      await quest.kill(Object.keys(persisted), quest.goblin.id, systemDesktop)
  );

  /* Replay the remote persist action on the client side (the new truth).
   * TODO: Maybe a new local persist was inserted while syncing with the
   *       server with ripleyServer. Maybe here, we should skip the persist
   *       coming from the server, because our client will send a new bunch
   *       of actions for this entity (again). I think that it will prevent
   *       a rebound with the UI.
   *       It should be easy to test if a new local persist exists with an
   *       higher rowid that provided to the server.
   */
  for (const goblinId of Object.keys(persisted)) {
    const localGoblin = await quest.create(goblinId, {
      id: goblinId,
      desktopId: systemDesktop,
    });
    await localGoblin.persist({
      action: persisted[goblinId].action,
      commitId: persisted[goblinId].commitId,
    });
  }

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
  commitId
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

  /* If the commitId is not known and other commitId already exist,
   * it's like trying to sync with an unrelated database.
   */
  return await cryo.hasCommitId({db, commitId});
});

Goblin.registerQuest(goblinName, '_ripleyCheckBeforeSync', async function (
  quest,
  db
) {
  const cryo = quest.getAPI('cryo');

  /* Retrieve the last synchronized commit. */
  const lastCommitId = await cryo.getLastCommitId({db});
  if (!lastCommitId?.commitId) {
    return;
  }

  /* Check if the server has this commitId too. */
  const passed = await quest.cmd('goblin.ripleyCheckForCommitId', {
    _xcraftRPC: true,
    db,
    commitId: lastCommitId?.commitId,
  });
  if (!passed) {
    throw new Error(
      `Stop syncing for ${db} where the local commitId ${lastCommitId?.commitId} is not known by the server`
    );
  }
});

Goblin.registerQuest(goblinName, 'ripleyClient', async function (quest, db) {
  const syncLock = xUtils.locks.getMutex;
  const cryo = quest.getAPI('cryo');

  /* The pause is used for the shutdown. Here we prevent a new sync. */
  const shuttingDown = 'ripley.shuttingDown';
  if (quest.goblin.getX(shuttingDown)) {
    quest.log.dbg('Ripley is shuttingDown, skip sync');
    return;
  }

  /* While a sync is running, we can't shutdown the client. The counter
   * can be used to know how many syncs are running.
   */
  const think = 'ripley.thinking';
  quest.goblin.setX(think, quest.goblin.getX(think, 0) + 1);
  quest.defer(() => {
    quest.goblin.setX(think, quest.goblin.getX(think) - 1);
    if (quest.goblin.getX(shuttingDown)) {
      quest.evt('<ripley-think>', {db});
    }
  });

  await syncLock.lock(`ripleyClient-${db}`);
  quest.defer(async () => await syncLock.unlock(`ripleyClient-${db}`));

  /* Check if our last commitId exists on the server. */
  await quest.me._ripleyCheckBeforeSync({db});

  /* Check if a previous sync was interrupted by searching for zero
   * commitId. In this case, we must ask the server for the corresponding
   * persisted actions.
   */
  const zeroActions = await cryo.getZeroActions({db});
  if (zeroActions.length) {
    const persisted = await quest.cmd('goblin.ripleyPersistFromZero', {
      _xcraftRPC: true,
      db,
      goblinIds: zeroActions.map(({goblin}) => goblin),
    });
    let entries = [];
    if (persisted) {
      entries = Object.values(persisted);
    }
    const rows = zeroActions.map(({rowid}) => rowid);
    if (entries.length) {
      const [{commitId}] = entries;
      await quest.me._ripleyApplyPersisted({
        db,
        persisted,
        newCommitId: commitId,
        rows,
      });
    } else {
      /* This persist is not known by the server, we must reset the zero commitId */
      await cryo.prepareDataForSync({db, rows, zero: false});
    }
  }

  const {stagedActions, lastCommitId} = await quest.me._ripleyPrepareSync({db});

  // (4) (9)
  await cryo.immediate({db});
  quest.defer(async () => await cryo.commit({db}));

  let newCommitId;
  let persisted;
  const rows = stagedActions.map(({rowid}) => rowid);
  try {
    ({newCommitId, persisted} = await wrapForSyncing(
      quest,
      db,
      async () =>
        await quest.cmd('goblin.ripleyServer', {
          _xcraftRPC: true,
          db,
          actions: stagedActions,
          lastClientCommitId: lastCommitId,
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
  }

  await quest.me._ripleyApplyPersisted({
    db,
    persisted,
    newCommitId,
    rows,
  });
});

Goblin.registerQuest(goblinName, 'tryShutdown', function* (quest) {
  /* Inform the sync stuff that we are shutting down */
  quest.goblin.setX('ripley.shuttingDown', true);

  const isThinking = () => !!quest.goblin.getX('ripley.thinking');
  if (isThinking()) {
    yield quest.sub.localWait('*::goblin.<ripley-think>');
  }

  return isThinking();
});

Goblin.registerQuest(goblinName, 'sysCreate', function* (
  quest,
  desktopId,
  goblinId
) {
  const systemFeed = quest.getSystemDesktop();
  yield quest.create(goblinId, {
    id: goblinId,
    desktopId: systemFeed,
  });
});

Goblin.registerQuest(goblinName, 'sysKill', function* (
  quest,
  desktopId,
  goblinId
) {
  const systemFeed = quest.getSystemDesktop();
  yield quest.kill([goblinId], [quest.goblin.id], systemFeed);
});

Goblin.registerQuest(goblinName, 'sysCall', function* (
  quest,
  desktopId,
  goblinId,
  namespace,
  questName,
  questArguments
) {
  const systemFeed = quest.getSystemDesktop();
  try {
    yield quest.create(namespace, {
      id: goblinId,
      desktopId: systemFeed,
    });
    return yield quest.cmd(`${namespace}.${questName}`, {
      id: goblinId,
      ...questArguments,
    });
  } finally {
    yield quest.kill([goblinId], [quest.goblin.id], systemFeed);
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
