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

    quest.sub(`*::warehouse.released`, (err, msg) => {
      Object.entries(msg.data)
        .map(([id, generation]) => ({
          name: Goblin.getGoblinName(id),
          id,
          generation,
        }))
        .filter(
          ({name, id}) => goblins[name] && goblins[name][id] && name !== id
        )
        .forEach(({name, id, generation}) => {
          try {
            quest.cmd(`${name}.delete`, {id, generation, _goblinLegacy: true});
          } catch (ex) {
            quest.log.err(ex.stack || ex);
          }
        });
    });

    yield quest.create('goblin-cache', {
      id: `goblin-cache@${xBus.getToken()}`,
    });

    console.log();
    console.log(yield xUtils.log.graffiti('goblin-core', next));
    console.log();
    console.log(
      `Woooah: ready to deliver ${Object.keys(goblins).length} pointy features!`
    );
    console.log();
  },
  ['*::warehouse.released']
);

Goblin.registerQuest(goblinName, 'status', function(quest) {
  const goblins = Goblin.getGoblinsRegistry();

  quest.log.info(`=================================`);
  quest.log.info(`=== Goblins                   ===`);
  quest.log.info(`=================================`);
  Object.keys(goblins)
    .sort()
    .forEach(name => {
      quest.log.info(`${name}:`);
      if (goblins[name]) {
        Object.keys(goblins[name]).forEach(gob => {
          quest.log.info(`  ${gob}`);
        });
      }
    });
  /*
  const sessions = Goblin.getSessionsRegistry();

  quest.log.info('');
  quest.log.info(`=================================`);
  quest.log.info(`=== Sessions                  ===`);
  quest.log.info(`=================================`);
  Object.keys(sessions)
    .filter(name => sessions[name] && Object.keys(sessions[name]).length)
    .sort()
    .forEach(name => {
      quest.log.info(`${name}:`);
      Object.keys(sessions[name]).forEach(id => {
        quest.log.info(`  ${id}`);
        Object.keys(sessions[name][id]).forEach(session => {
          quest.log.info(`    ${session}`);
        });
      });
    });
  */
});

// Singleton
module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
Goblin.createSingle(goblinName);
