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

Goblin.registerQuest(goblinName, 'ripleyServer', function* (
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

  // (4)
  yield cryo.immediate({db});
  // (9)
  quest.defer(async () => {
    quest.log.dbg(`[${lastClientCommitId}] ripleyServer commit for ${db} `);
    await cryo.commit({db});
  });

  quest.log.dbg(`[${lastClientCommitId}] ripleyServer locked for ${db}`);

  // (5)
  const lastCommitId = yield cryo.getLastCommitId({db});

  try {
    /* Prepare the individual actions */
    for (const {action: actionStr} of actions) {
      const action = JSON.parse(actionStr);
      const goblinId = action.meta.id;
      let goblin;

      if (!goblins[goblinId]) {
        goblin = yield quest.create(goblinId, {
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

    // (6)
    for (const {goblin, actions} of Object.values(goblins)) {
      if (!newCommitId) {
        newCommitId = quest.uuidV4();
      }
      const data = yield goblin.$4ellen({
        actions,
        commitId: newCommitId,
      });
      if (data) {
        data.commitId = newCommitId;
        persisted[goblin.id] = data;
      }
    }

    // (8)
    const rangeOfActions = yield cryo.getPersistFromRange({
      db,
      fromCommitId: lastClientCommitId,
      toCommitId: lastCommitId?.commitId,
    });

    quest.log.dbg(
      `[${lastClientCommitId}] ripleyServer for ${db}, range ${lastClientCommitId}:${lastCommitId?.commitId} with ${rangeOfActions.length} actions`
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

    // (10)
    return {newCommitId, persisted};
  } finally {
    yield quest.kill(Object.keys(goblins), quest.goblin.id, systemDesktop);
  }
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

  try {
    const horde = xBus
      .getCommander()
      .getRoutingKeyFromId('goblin.ripleyServer', null, true);

    timeout = setTimeout(() => {
      timeout = null;
      sendSyncing(quest, db, horde, true);
    }, 1000);

    quest.defer(() => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      setTimeout(() => sendSyncing(quest, db, horde, false), 1000);
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

Goblin.registerQuest(goblinName, 'ripleyClient', function* (quest, db) {
  const systemDesktop = `system@ripley`;

  const cryo = quest.getAPI('cryo');

  // (4)
  yield cryo.immediate({db});
  // (9)
  quest.defer(async () => await cryo.commit({db}));

  // (1) and (2)
  /* Retrieve all non-persist actions between the last sync and now. */
  const {stagedActions, lastCommitId} = yield cryo.getDataForSync({db});

  const {newCommitId, persisted} = yield wrapForSyncing(
    quest,
    db,
    async () =>
      await quest.cmd('goblin.ripleyServer', {
        _xcraftRPC: true,
        db,
        actions: stagedActions,
        lastClientCommitId: lastCommitId,
      })
  );

  /* Tag new non-persist actions with the zero commitId
   *   00000000-0000-0000-0000-000000000000
   * If everything works fine, the zero commitId will be changed to the
   * effective commitId. Zero tagged commits must not be sent anymore,
   * otherwise it's possible to generate bad duplicated entries.
   */
  let rows;
  if (stagedActions) {
    rows = stagedActions.map(({rowid}) => rowid);
    if (rows.length) {
      yield cryo.prepareDataForSync({rows});
    }
  }

  try {
    /* Replay the remote persist action on the client side (the new truth). */
    for (const goblinId of Object.keys(persisted)) {
      const localGoblin = yield quest.create(goblinId, {
        id: goblinId,
        desktopId: systemDesktop,
      });
      yield localGoblin.persist({
        action: persisted[goblinId].action,
        commitId: persisted[goblinId].commitId,
      });
    }

    // (12)
    /* Replace the zero commitId by the server commitId. The sync is finished
     * for these actions.
     */
    if (newCommitId && rows?.length) {
      yield cryo.updateActionsAfterSync({
        db,
        serverCommitId: newCommitId,
        rows,
      });
    }
  } finally {
    yield quest.kill(Object.keys(persisted), quest.goblin.id, systemDesktop);
  }
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
