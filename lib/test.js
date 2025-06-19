'use strict';

if (!process.env.XCRAFT_ROOT) {
  const xHost = require('xcraft-core-host');
  process.env.GOBLINS_APP = `${xHost.appId}@${xHost.variantId}`;
  process.env.XCRAFT_ROOT = xHost.appConfigPath;
  require('xcraft-server/lib/init-env.js').initEtc(
    xHost.appConfigPath,
    xHost.projectPath
  );
}

module.exports = require('./index.js');
