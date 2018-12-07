'use strict';

const path = require('path');
const Goblin = require('./index.js');

const goblinName = path.basename(module.parent.filename, '.js');

const logicState = {};

const logicHandlers = {
  create: (state, action) => state.set('id', action.get('id')),
};

Goblin.registerQuest(goblinName, 'create', function(quest) {
  quest.do();
  return quest.goblin.id;
});

Goblin.registerQuest(goblinName, 'delete', function(quest) {
  quest.do();
});

module.exports = Goblin.configure(goblinName, logicState, logicHandlers);
