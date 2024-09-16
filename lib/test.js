'use strict';

if (!process.env.XCRAFT_ROOT) {
  const fs = require('fs');
  const xHost = require('xcraft-core-host');
  // @ts-ignore
  process.env.XCRAFT_ROOT = fs.existsSync(xHost.appConfigPath)
    ? xHost.appConfigPath
    : xHost.projectPath;
}

module.exports = require('./index.js');
