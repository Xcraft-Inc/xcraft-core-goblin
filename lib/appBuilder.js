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
  if (config.useWorkshop) {
    setDefault('desktop', 'desktop');
    setDefault('themeContext', 'theme');
    setDefault('defaultTheme', 'default');
    setDefault('defaultContextId', appId);
    setDefault('configureNewDesktopSessionQuest', function* (quest, desktopId) {
      const desk = quest.getAPI(desktopId);
      const appContext = {contextId: appId, name: appId};
      yield desk.addContext(appContext);
      yield desk.setNavToDefault({
        defaultContextId: config.defaultContextId,
      });
    });
  }

  if (config.quests) {
    for (const [questName, quest] of Object.entries(config.quests)) {
      Goblin.registerQuest(appId, questName, quest);
    }
  }

  const logicState = {
    id: appId,
  };

  const logicHandlers = {
    ...config.logicHandlers,
  };

  Goblin.registerQuest(appId, 'boot', function* (quest, $msg, next) {
    console.log(
      '\x1b[32m%s\x1b[0m',
      `Goblin-${appId}: ${config.icon} booting...`
    );
    let desktopId = `system@${appId}`;
    if (config.useWorkshop) {
      const {
        mandate,
        elasticsearchUrl,
        rethinkdbHost,
        useNabu,
      } = require('xcraft-core-etc')().load(`goblin-${appId}`).profile;
      desktopId = `system@${mandate}`;
      const configuration = {
        mandate,
        elasticsearchUrl,
        rethinkdbHost,
        useNabu,
        mainGoblin: appId,
        defaultContextId: config.defaultContextId,
      };
      quest.goblin.setX('configuration', configuration);

      yield quest.cmd('workshop.init', {
        configuration,
        desktopId,
        appName: appId,
      });
    }

    //custom boot override
    if (config.quests.boot) {
      const _boot = config.quests.boot;
      const xUtils = require('xcraft-core-utils');
      const params = xUtils.reflect
        .funcParams(_boot)
        .filter((param) => !/^(quest|next)$/.test(param));

      const boot = (q, m, n) => {
        const args = params.map((p) => {
          return m.get(p);
        });

        /* Pass the whole Xcraft message if asked by the quest. */
        if (!m.get('$msg')) {
          const idx = params.indexOf('$msg');
          if (idx > -1) {
            args[idx] = m;
          }
        }

        args.unshift(q);
        if (n) {
          args.push(n);
        }

        return _boot(...args);
      };
      const {js} = xUtils;
      //inject desktopId in message data
      $msg.data.desktopId = desktopId;
      if (js.isGenerator(_boot)) {
        yield* boot(quest, $msg, next);
      } else {
        boot(quest, $msg);
      }
    }

    console.log(
      '\x1b[32m%s\x1b[0m',
      `Goblin-${appId}: ${config.icon} booting...[DONE]`
    );
  });

  if (config.useWorkshop) {
    Goblin.registerQuest(appId, 'getMandate', function (quest) {
      const {mandate} = require('xcraft-core-etc')().load(`goblin-${appId}`);
      return mandate;
    });

    Goblin.registerQuest(appId, 'configureDesktop', function (quest) {
      return {
        defaultTheme: config.defaultTheme,
        themeContext: config.themeContext,
      };
    });

    Goblin.registerQuest(
      appId,
      'configureNewDesktopSession',
      config.configureNewDesktopSessionQuest
    );
  }

  const app = Goblin.configure(appId, logicState, logicHandlers);
  Goblin.createSingle(appId);
  return app;
};
