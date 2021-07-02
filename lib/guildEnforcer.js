const {concat} = require('lodash');

const enforcer = {skills: new Set()};
module.exports = (coreGoblinConfig) => {
  const {Capability, SkillsSet} = require('./capsAndSkills.js');
  const path = require('path');
  const {appCompany, appData} = require('xcraft-core-host');
  const {mkdir} = require('fs-extra');
  const appConfigRoot = path.join(appData, appCompany);
  mkdir(appConfigRoot);
  const guildDefPath = path.join(appConfigRoot, coreGoblinConfig.guildsFile);
  //todo: read guild def file
  console.log(guildDefPath);
  //mock
  const guildsDef = {
    demoGuild: {
      id: 'guild@demo',
      members: [
        {id: 'user@demo-master', rank: 'master'},
        {id: 'user@demo-guest', rank: 'guest'},
      ],
    },
  };
  const ranksDef = {
    master: ['RUN_QUEST', 'OPEN_DESKTOP'],
    guest: ['RUN_QUEST'],
    system: ['*'],
  };
  enforcer.guilds = guildsDef;
  enforcer.mainGuild = 'demoGuild';
  enforcer.ranks = ranksDef;

  const shielded = {};
  enforcer.shield = (cmd, quest, skills) => {
    const shield = {quest, skillsSet: SkillsSet.define(quest, skills)};
    shielded[cmd] = shield;
    return shield;
  };

  enforcer.isBlocked = (goblin, cmd) => {
    const shield = shielded[cmd];
    return !shield.skillsSet.isCapable(goblin);
  };

  enforcer.enforce = (goblin, rank) => {
    const caps = [];
    enforcer.ranks[rank].forEach((s) =>
      caps.push(Capability.create(goblin, Symbol.for(s)))
    );
    goblin.capabilities = caps;
  };

  return Object.freeze(enforcer);
};
