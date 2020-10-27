'use strict';

module.exports = (queueName, config) => {
  const Goblin = require('./index.js');

  if (!queueName) {
    throw new Error('queueName not provided');
  }
  if (!config) {
    throw new Error('config not provided');
  }
  if (!config.workQuest) {
    throw new Error('cannot create a worker queue without a work quest');
  }

  const workerName = `${queueName}-worker`;
  Goblin.registerQuest(workerName, 'create', function (quest) {
    quest.do();
  });
  Goblin.registerQuest(workerName, 'work', config.workQuest);
  Goblin.registerQuest(workerName, 'delete', function () {});

  const workerService = Goblin.configure(
    workerName,
    {},
    {
      create: (state, action) => {
        return state.set('id', action.get('id'));
      },
    },
    {
      schedulingMode: 'background',
    }
  );

  return workerService;
};
