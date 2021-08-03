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
        quest.cmd(
          `${name}.delete`,
          {
            id,
            generation,
            _goblinLegacy: true,
          },
          next.parallel()
        );
      } catch (ex) {
        quest.log.err(ex.stack || ex);
      }
    }
    yield next.sync();
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

  quest.sub.local(`*::*<goblin-run>`, function* (err, {msg, resp}) {
    const {calledFrom, cmd, cmdArgs} = msg.data;
    try {
      yield resp.cmd(cmd, {...cmdArgs});
    } catch (ex) {
      throw new Error(`quest.go(): error during call
      called from: ${calledFrom}
      quest.go('${cmd}',${JSON.stringify(cmdArgs)})`);
    }
  });

  console.log();
  console.log(yield xUtils.log.graffiti('goblin-core', next));
  console.log();
  console.log(`Woooah: ready to deliver ${goblins.size} pointy features!`);
  console.log();
});

Goblin.registerQuest(goblinName, 'cache-clear', function* (quest) {
  const cache = quest.getAPI(`goblin-cache@${xBus.getToken()}`);
  yield cache.clear();
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

Goblin.registerQuest(goblinName, 'enroleUser', function (quest, token) {
  Goblin.enroleUser(token);
});

Goblin.registerQuest(goblinName, 'xcraftMetrics', function (quest) {
  const os = require('os');
  const {appId} = require('xcraft-core-host');
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
        metrics[`${os.hostname()}.${appId}.${goblinId}.${metric}`] =
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

    metrics[`${os.hostname()}.${appId}.${goblinName}.localStorage`] = {
      total: localStorageKeysTotal,
      labels: {appId},
    };
  }

  metrics[`${os.hostname()}.${appId}.goblinInstances`] = {
    total: numberOfInstances,
    labels: {appId},
  };
  metrics[`${os.hostname()}.${appId}.scheduler.parallelQueues`] = {
    total: parallelQueues,
    labels: {appId, mode: 'parallel'},
  };
  metrics[`${os.hostname()}.${appId}.scheduler.immediateQueues`] = {
    total: immediateQueues,
    labels: {appId, mode: 'immediate'},
  };
  metrics[`${os.hostname()}.${appId}.scheduler.serieQueues`] = {
    total: serieQueues,
    labels: {appId, mode: 'serie'},
  };
  metrics[`${os.hostname()}.${appId}.runningQuests`] = {
    total: runningQuests,
    labels: {appId},
  };

  return metrics;
});

// Singleton
module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
Goblin.createSingle(goblinName);
