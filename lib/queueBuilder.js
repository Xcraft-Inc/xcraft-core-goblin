'use strict';

module.exports = (queueName, config) => {
  const Goblin = require('./index.js');
  const {JobQueue} = require('xcraft-core-utils');

  if (!queueName) {
    throw new Error('queueName not provided');
  }
  if (!config) {
    throw new Error('config not provided');
  }
  if (!config.sub) {
    throw new Error('cannot create a worker queue without a sub');
  }

  const setDefault = (v, d) => {
    if (config[v] === undefined || config[v] === null) {
      config[v] = d;
    }
  };
  setDefault('queueSize', 100);
  setDefault('jobIdGetter', (msg) => msg.id);

  Goblin.registerQuest(
    queueName,
    'init',
    function (quest) {
      const workerQueue = new JobQueue(
        queueName,
        function* ({work, resp}) {
          yield resp.cmd(`${queueName}.start-worker`, work);
        },
        config.queueSize
      );

      quest.goblin.defer(
        quest.sub(config.sub, function (err, {msg, resp}) {
          if (!msg.data.desktopId) {
            throw new Error(`missing desktopId for worker ${queueName}`);
          }
          workerQueue.push({
            id: config.jobIdGetter(msg),
            work: {
              $orcName: msg.orcName,
              ...msg.data,
              ...{desktopId: Goblin.getSystemDesktop(msg.data.desktopId)},
            },
            resp,
          });
        })
      );
      quest.log.info(`${queueName} initialized`);
    },
    [config.sub]
  );

  Goblin.registerQuest(queueName, 'start-worker', function* (quest, $msg) {
    if (!$msg.data.desktopId) {
      throw new Error('cannot start a worker without a desktopId');
    }
    $msg.data.desktopId = quest.getSystemDesktop();
    const workerId = `${queueName}-worker@${quest.uuidV4()}`;
    try {
      const workerAPI = yield quest.create(workerId, {
        id: workerId,
        desktopId: quest.getSystemDesktop(),
      });
      yield workerAPI.work({
        ...$msg.data,
      });
    } finally {
      yield quest.kill([workerId]);
      const jobId = $msg.data.jobId;
      if (jobId) {
        quest.evt(`${jobId}.done`);
      }
    }
  });

  const queueService = Goblin.configure(
    queueName,
    {
      id: queueName,
    },
    {}
  );
  Goblin.createSingle(queueName);

  return queueService;
};
