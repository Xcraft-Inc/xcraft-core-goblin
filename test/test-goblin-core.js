'use strict';

const goblinName = 'test-goblin-core';
const Goblin = require('xcraft-core-goblin');

// Define initial logic values
const logicState = {
  counter: 0,
};

// Define logic handlers according rc.json
const logicHandlers = {
  create: (state, action) => {
    return state.set('id', action.get('id'));
  },
  bump: (state) => {
    return state.set('counter', state.get('counter') + 1);
  },
};

// Register quest's according rc.json
Goblin.registerQuest(goblinName, 'create', function* (
  quest,
  wait,
  _goblinCaller,
  next
) {
  quest.log.info(`Creating ${quest.goblin.id} from ${_goblinCaller}`);
  quest.do();
  setTimeout(next.parallel(), wait);
  yield next.sync();
  quest.dispatch('bump');
  return quest.goblin.id;
});

Goblin.registerQuest(goblinName, 'get-counter', function (quest) {
  return quest.goblin.getState().get('counter');
});

Goblin.registerQuest(goblinName, 'delete', function (quest) {});

exports.xcraftCommands = function () {
  // Create a Goblin with initial state and handlers
  return Goblin.configure(goblinName, logicState, logicHandlers);
};
