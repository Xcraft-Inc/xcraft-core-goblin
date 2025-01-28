'use strict';

const goblinName = 'goblin-orc';
const Goblin = require('..');

/******************************************************************************/

// Define initial logic values.
const logicState = {};

const logicHandlers = {
  create: (state, action) =>
    state.set('', {
      id: action.get('id'),
      data: {},
    }),

  setData: (state, action) =>
    state.set('data.' + action.get('key'), action.get('data')),
};

/******************************************************************************/

Goblin.registerQuest(goblinName, 'create', function (quest) {
  quest.do();
  return quest.goblin.id;
});

Goblin.registerQuest(goblinName, 'delete', function (quest) {});

Goblin.registerQuest(goblinName, 'setData', function (quest) {
  quest.do();
  quest.log.dbg(quest.goblin.getState().toJS());
});

/******************************************************************************/

module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
