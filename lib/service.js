'use strict';

const path = require('path');
const Goblin = require('./index.js');
const xBus = require('xcraft-core-bus');
const xUtils = require('xcraft-core-utils');

const goblinName = path.basename(module.parent.filename, '.js');

const logicState = {};

const logicHandlers = {};

Goblin.registerQuest(
  goblinName,
  'init',
  function*(quest, next) {
    const goblins = Goblin.getGoblinsRegistry();

    quest.sub(`*::warehouse.released`, function*(err, {msg}) {
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

    yield quest.create('goblin-cache', {
      id: `goblin-cache@${xBus.getToken()}`,
      desktopId: 'system',
    });

    console.log();
    console.log(yield xUtils.log.graffiti('goblin-core', next));
    console.log();
    console.log(`Woooah: ready to deliver ${goblins.size} pointy features!`);
    console.log();
  },
  ['*::warehouse.released']
);

Goblin.registerQuest(goblinName, 'cache-clear', function*(quest) {
  const cache = quest.getAPI(`goblin-cache@${xBus.getToken()}`);
  yield cache.clear();
});

Goblin.registerQuest(goblinName, 'status', function(quest) {
  const goblins = Goblin.getGoblinsRegistry();

  quest.log.info(`=================================`);
  quest.log.info(`=== Goblins                   ===`);
  quest.log.info(`=================================`);
  Array.from(goblins.keys())
    .sort()
    .forEach(name => {
      quest.log.info(`${name}`);
      if (goblins.has(name)) {
        goblins.get(name).forEach(gob => {
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

// Singleton
module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
Goblin.createSingle(goblinName);
