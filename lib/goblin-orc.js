'use strict';

const goblinName = 'goblin-orc';
const Goblin = require('xcraft-core-goblin');

/******************************************************************************/

// Define initial logic values.
const logicState = {};

const logicHandlers = {
  create: (state, action) =>
    state.set('', {
      id: action.get('id'),
    }),
};

/******************************************************************************/

Goblin.registerQuest(goblinName, 'create', function (quest) {
  quest.do();
  return quest.goblin.id;
});

Goblin.registerQuest(goblinName, 'delete', function (quest) {});

/******************************************************************************/

module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
