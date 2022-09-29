'use strict';

const os = require('os');
const guestHost = os.hostname().toLowerCase().replace(/@/g, '-');
const guestUser = os.userInfo().username.toLowerCase().replace(/@/g, '-');

module.exports = {
  guestHost,
  guestUser,
};
