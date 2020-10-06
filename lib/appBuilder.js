'use strict';

module.exports = (appId, config) => {
  const Goblin = require('./index.js');
  if (!appId) {
    throw new Error('appId not provided');
  }
  if (!config) {
    config = {};
  }
  const setDefault = (v, d) => {
    if (config[v] === undefined || config[v] === null) {
      config[v] = d;
    }
  };
  setDefault('quests', {});
  setDefault('logicHandlers', {});
  setDefault('icon', '👺');
  setDefault('useWorkshop', true);
  setDefault('useNabu', true);
  setDefault('desktop', 'desktop');
  setDefault('defaultContext', appId);
  setDefault('contexts', {[appId]: appId});

  if (config.quests) {
    for (const [questName, quest] of Object.entries(config.quests)) {
      Goblin.registerQuest(appId, questName, quest);
    }
  }

  const logicState = {
    id: appId,
  };

  const logicHandlers = {
    'open-desktop': (state) => {
      return state.set('userCount', state.get('userCount') + 1);
    },
    'close-desktop': (state) => {
      return state.set('userCount', state.get('userCount') - 1);
    },
    ...config.logicHandlers,
  };

  Goblin.registerQuest(appId, 'boot', function* (quest) {
    console.log(
      '\x1b[32m%s\x1b[0m',
      `Goblin-${appId}: ${config.icon} booting...`
    );
    if (config.useWorkshop) {
      yield quest.cmd('workshop.init');
      const {
        mandate,
        elasticsearchUrl,
        rethinkdbHost,
      } = require('xcraft-core-etc')().load(`goblin-${appId}`);

      const desktopId = `system@${mandate}`;
      const configuration = {
        mandate,
        elasticsearchUrl,
        rethinkdbHost,
      };
      quest.goblin.setX('configuration', configuration);

      const entityBuilderConfig = require('goblin-workshop').buildEntity;

      const {
        customIndexesByType,
        orderIndexesByType,
        indexerMappingsByType,
      } = entityBuilderConfig;
      const workshopAPI = quest.getAPI('workshop');
      try {
        yield workshopAPI.initStorage({
          desktopId,
          configuration,
          customIndexesByType,
          orderIndexesByType,
        });
        yield workshopAPI.initIndexer({
          configuration,
          indexerMappingsByType,
        });
        if (config.useNabu) {
          const nabuAPI = quest.getAPI('nabu');
          yield nabuAPI.init({
            desktopId,
            appName: appId,
            configuration,
          });
        }
      } catch (err) {
        throw new Error(
          `Fatal error occured during ${appId} system storage initialization, check your storages services!`
        );
      }
    }
    console.log(
      '\x1b[32m%s\x1b[0m',
      `Goblin-${appId}: ${config.icon} booting...[DONE]`
    );
  });

  Goblin.registerQuest(appId, 'configure-desktop', function* (
    quest,
    clientSessionId,
    labId,
    desktopId,
    session,
    username,
    locale,
    configuration
  ) {
    const desktopConfig = yield quest.me.openDesktop({
      clientSessionId,
      labId,
      desktopId,
      session,
      username,
      locale,
      configuration,
    });
    return desktopConfig;
  });

  Goblin.registerQuest(appId, 'open-desktop', function* (
    quest,
    clientSessionId,
    labId,
    desktopId,
    session,
    username,
    configuration
  ) {
    if (!configuration) {
      configuration = quest.goblin.getX('configuration');
    }
    if (desktopId === labId) {
      desktopId = `${config.desktop}@${configuration.mandate}@${username}`;
    }
    // CREATE A DESKTOP
    quest.log.dbg(`${username} opening desktop...`);
    const desk = yield quest.createFor(config.destkop, desktopId, desktopId, {
      id: desktopId,
      desktopId,
      clientSessionId,
      labId,
      session,
      username,
      useNabu: config.useWorkshop && config.useNabu,
      configuration,
    });

    const exSession = quest.goblin.getX(`${desktopId}.session`);
    if (!exSession) {
      quest.goblin.setX(
        `${desktopId}.session`,
        quest.sub(`*::${desktopId}.session.closed`, function* ({msg, resp}) {
          yield resp.cmd(`${appId}.close-desktop`, {
            clientSessionId,
            desktopId,
          });
        })
      );

      if (config.desktop === 'desktop') {
        for (const [contextId, name] of Object.entries(config.contexts)) {
          const ctx = {
            contextId,
            name,
          };
          yield desk.addContext(ctx);
        }
      }
    }

    quest.do();
    yield desk.setNavToDefault({defaultContextId: config.defaultContext});
    quest.log.dbg(`${username} opening desktop...[DONE]`);
    return {desktopId};
  });

  Goblin.registerQuest(appId, 'close-desktop', function (quest, desktopId) {
    quest.do();
    if (quest.goblin.getX(`${desktopId}.session`)) {
      quest.goblin.getX(`${desktopId}.session`)();
      quest.goblin.delX(`${desktopId}.session`);
    }

    quest.evt(`${desktopId}.closed`);
  });

  const app = Goblin.configure(appId, logicState, logicHandlers);
  Goblin.createSingle(appId);
  return app;
};
