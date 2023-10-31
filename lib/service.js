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

  const goblinConfig = require('xcraft-core-etc')().load('xcraft-core-goblin');
  if (goblinConfig.enableActionsSync) {
    const hordesSync = require('./elf/hordesSync.js');
    quest.sub('*::cryo-db-synced', (err, {msg, rep}) => {
      const {db} = msg.data;
      hordesSync().syncDB(db);
    });

    const dbs = Goblin.getAllRipleyDB();
    for (const db of dbs) {
      hordesSync().syncDB(db);
    }
  }

  const xHost = require('xcraft-core-host');
  const {appId} = xHost;
  const appArgs = xHost.appArgs();
  const {tribe} = appArgs;
  console.log();
  console.log(yield xUtils.log.graffiti('goblin-core', next));
  console.log();
  console.log(`appId: ${appId} tribe: ${tribe}`);
  if (goblinConfig.enableActionsSync) {
    console.log(`Actions sync party started`);
  }
  console.log(`Woooah: ready to deliver ${goblins.size} pointy features!`);
  console.log();
});

Goblin.registerQuest(goblinName, 'cache-clear', function* (quest) {
  const cache = quest.getAPI(`goblin-cache@${xBus.getToken()}`);
  yield cache.clear();
});

Goblin.registerQuest(goblinName, 'ripleyOne', function* (quest, db, goblin) {
  const data = yield quest.cmd('cryo.getLastPersist', {
    db,
    goblin,
    _xcraftRPC: true,
  });
  if (!data) {
    return;
  }

  const goblinId = goblin.substring(goblin.indexOf('-') + 1);
  const goblinExists = yield quest.warehouse.has({path: goblinId});
  if (goblinExists) {
    const systemDesktop = `system@ripley`;
    const localGoblin = yield quest.create(goblinId, {
      id: goblinId,
      desktopId: systemDesktop,
    });
    /*const hash =*/ yield localGoblin.persist({
      action: data.action,
    });
  } else {
    const rules = {goblin, mode: 'all'};
    yield quest.cmd('cryo.freeze', {
      db,
      hash: data.hash,
      action: {
        type: 'persist',
        meta: {
          action: data.action,
          _cryoUUID: data.uuid,
        },
      },
      rules,
      raw: true,
    });
  }
});

Goblin.registerQuest(goblinName, 'ripleyRevoke', function* (quest, db, goblin) {
  const data = yield quest.cmd('cryo.getLastRevoke', {db, goblin});
  if (!data) {
    return;
  }

  const systemDesktop = `system@ripley`;
  const goblinId = goblin.substring(goblin.indexOf('-') + 1);

  const goblinSrv = yield quest.create(goblinId, {
    id: goblinId,
    desktopId: systemDesktop,
    _xcraftRPC: true,
  });

  const action = JSON.parse(data.action);
  action.meta._cryoUUID = data.uuid;
  const actions = [action];
  yield goblinSrv.$4ellen({
    actions,
    _xcraftRPC: true,
  });
});

Goblin.registerQuest(goblinName, 'ripleyLocalRevoke', function* (
  quest,
  db,
  goblin
) {
  const systemDesktop = `system@ripley`;
  const goblinId = goblin.substring(goblin.indexOf('-') + 1);
  const data = yield quest.cmd('cryo.getLastRevoke', {
    db,
    goblin,
    desktopId: systemDesktop,
    _xcraftRPC: true,
  });
  if (!data) {
    return;
  }

  const goblinSrv = yield quest.create(goblinId, {
    id: goblinId,
    desktopId: systemDesktop,
  });

  const action = JSON.parse(data.action);
  action.meta._cryoUUID = data.uuid;
  const actions = [action];
  yield goblinSrv.$4ellen({
    actions,
  });
});

Goblin.registerQuest(goblinName, 'ripley', function* (quest, actions) {
  const systemDesktop = `system@ripley`;
  const goblins = {};
  try {
    /* Prepare the individual actions */
    for (const {action: actionStr, uuid} of actions) {
      const action = JSON.parse(actionStr);
      const goblinId = action.meta.id;
      let goblin;

      if (!goblins[goblinId]) {
        goblin = yield quest.create(goblinId, {
          id: goblinId,
          desktopId: systemDesktop,
          _xcraftRPC: true,
        });
        goblins[goblinId] = {goblin, actions: []};
      }

      action.meta._cryoUUID = uuid;
      goblins[goblinId].actions.push(action);
    }

    /* Run the server special ellen quest which will run actions
     * and replicates the new persist to the clients.
     */
    const persisted = {};
    for (const {goblin, actions} of Object.values(goblins)) {
      const data = yield goblin.$4ellen({
        actions,
        _xcraftRPC: true,
      });
      if (data) {
        persisted[goblin.id] = data;
      }
    }

    /* Replay the remote persist action on the client side (the new truth).
     * The hash must be the same.
     */
    for (const goblinId of Object.keys(persisted)) {
      const localGoblin = yield quest.create(goblinId, {
        id: goblinId,
        desktopId: systemDesktop,
      });
      /*const hash =*/ yield localGoblin.persist({
        action: persisted[goblinId].action,
      });
      /*if (persisted[goblinId].hash !== hash) {
        console.log('@@@');
      }*/
    }
  } finally {
    // FIXME: kill on the server side
    yield quest.kill(Object.keys(goblins), quest.goblin.id, systemDesktop);
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
