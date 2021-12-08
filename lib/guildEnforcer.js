///////////////////////////////////////////////////////////////////////////////
// GUILD ENFORCER
// SamLeBarbare, Août 2021
//
// Principes:
// chaque instances core-goblin dispose de son api de sécurité "guildEnforcer"
//
// Lors du require initial de core-goblin, on prépare la politique de sécurité
// la présence d'un fichier de définition de la politique de sécurité permet
// de définir les régles de bases.
//
// Si aucune régles ne sont spécifiée, on utilisera une politique initiale
// qui utilise les jetons JWT pour identifier et définir "rank"
// de capacité de l'utilisateur pour ce noeud.
//
// Un utilisateur non identifié est considéré avec un "rank" de niveau invité.
//
// Toute quête appelée est attribuée à un utilisateur, lors de cette attribution
// on identifie l'utilisateur à l'aide de la propriété _goblinUser présente
// dans le message en provenance du bus.
//
// le _goblinUser ne dois pas remonter par evt chez d'autres clients du bus.
//
// Les points d'injection du goblinUser sont sensibles, la propagation par
// commande, voir par événements doit être effectuée par le framework.
//
// si la propriété est manquante on enregistre l'empreinte de l'utilisateur
// ayant emis le message, on ajoute l'utilisateur comme invité et on enregistre
// son activité.
//
// Les acteurs goblins peuvent être déclaré avec un "rank" spécifique
// Chaque appel d'une instance à une autre est vérifié.
//
// Si le niveau de privilège est insuffisant, l'appel échoue par une ShieledError
//
// policies.json:
// enroling by claims:
// [claim]: {
//   [value]:[grantedRank]
// }
//
class ShieldedError extends Error {
  constructor(subject, ...params) {
    super(...params);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ShieldedError);
    }
    this.name = 'ShieldedError';
    this.message = 'blocked';
    this.subject = subject;
    this.date = new Date();
  }
}
const enforcer = {skills: new Set()};
module.exports = (busConfig) => {
  const {Capability, SkillsSet} = require('./capsAndSkills.js');
  const path = require('path');
  const {resourcesPath} = require('xcraft-core-host');
  const {readJSONSync} = require('fs-extra');
  const policiesJSONFile = path.join(resourcesPath, busConfig.policiesPath);
  const policies = readJSONSync(policiesJSONFile, {throws: false});

  // base def used in scope:
  let members;
  let ranks;
  let enroleByClaims;
  if (policies) {
    //todo: checkup imported policies
    members = policies.members;
    ranks = policies.ranks;
    enroleByClaims = policies.enroleByClaims;
  } else {
    let lvl = busConfig.defaultPolicyLevel ?? 0;
    //lvl
    //0: allow system to run all (bad defaults)
    //1: enroled via auth token only
    const defaultRanks = {};
    switch (lvl) {
      case 0:
        defaultRanks.system = ['*'];
        defaultRanks.guest = ['*'];
        break;
      case 1:
        defaultRanks.system = ['*'];
        defaultRanks.guest = [];
        defaultRanks.authentified = ['*'];
        break;
    }

    const def = {
      members: [],
      enroleByClaims: {
        aud: {goblins: 'authentified'},
      },
      ranks: {
        ...defaultRanks,
      },
    };
    members = def.members;
    ranks = def.ranks;
    enroleByClaims = def.enroleByClaims;
  }

  /////////////////////////////////
  // Predictions is a
  // cmd <-> role mapping for preventing
  // blocked actions
  const predictions = {};
  const predict = (cmd) => {
    for (const rank of Object.keys(ranks)) {
      const tempRef = {id: 'tempRef'};
      enforcer.enforce(tempRef, rank);
      if (!predictions[cmd]) {
        predictions[cmd] = {};
      }
      predictions[cmd][rank] = enforcer.isBlocked(tempRef, cmd);
    }
  };

  enforcer.getRankingPredictions = (cmd) => predictions[cmd];

  /////////////////////////////////
  //shields protect quest from call
  const shielded = {};
  enforcer.shield = (cmd, quest, skills) => {
    const shield = {quest, skillsSet: SkillsSet.define(quest, skills)};
    shielded[cmd] = shield;
    predict(cmd);
    return shield;
  };

  //////////////////////////////////////
  //helper for checking if a goblin
  //can run a command
  enforcer.isBlocked = (goblin, cmd) => {
    const shield = shielded[cmd];
    return !shield.skillsSet.isCapable(goblin);
  };

  enforcer.ShieldedError = ShieldedError;

  enforcer.enforce = (object, rank) => {
    const caps = [];
    ranks[rank].forEach((s) =>
      caps.push(Capability.create(object, Symbol.for(s)))
    );
    object.capabilities = caps;
  };

  ////////////////////////////////////////
  //users registry
  const users = {};

  //cleanup non-member user (guest) every minutes
  setInterval(() => {
    const timestamp = Date.now();
    for (const [key, user] of Object.entries(users)) {
      if (
        user.member === false &&
        user.lastAccess &&
        user.lastAccess + 300000 < parseInt(timestamp)
      ) {
        //todo: use bus log
        console.log(
          'deleting non active user:',
          user.login,
          'last access: ',
          new Date(user.lastAccess).toUTCString()
        );
        delete users[key];
      }
    }
  }, 60000);

  for (const member of Object.values(members)) {
    const user = {
      id: member.id,
      login: member.login,
      rank: member.rank,
      createdAt: Date.now(),
      lastAccess: null,
      member: true,
      canDo: (cmd) => {
        const isBlocked = predictions[cmd]
          ? predictions[cmd][member.rank]
          : true;
        return !isBlocked;
      },
    };
    enforcer.enforce(user, member.rank);
    users[member.id] = user;
  }

  enforcer.users = users;

  enforcer.addGuestUser = (footprint) => {
    const user = {
      id: footprint,
      login: footprint,
      rank: 'guest',
      createdAt: Date.now(),
      lastAccess: Date.now(),
      member: false,
      canDo: (cmd) => {
        const isBlocked = predictions[cmd] ? predictions[cmd]['guest'] : true;
        return !isBlocked;
      },
    };
    enforcer.enforce(user, 'guest');
    users[footprint] = user;
  };

  enforcer.deroleUser = (tokenData) => {
    const {subject} = tokenData;
    delete users[subject];
  };

  enforcer.enroleUser = (tokenData) => {
    const id = tokenData.sub;
    const login = tokenData.login;
    let rank = 'denied';
    //try to get a rank from claims
    for (const [claim, value] of Object.entries(tokenData)) {
      if (enroleByClaims[claim] && enroleByClaims[claim][value]) {
        rank = enroleByClaims[claim][value];
      }
    }
    //fail if nothing match
    if (rank === 'denied') {
      throw new Error(`Cannot enrole ${login}`);
    }
    const user = {
      id,
      login: login,
      rank,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      member: true,
      canDo: (cmd) => {
        const isBlocked = predictions[cmd] ? predictions[cmd][rank] : true;
        return !isBlocked;
      },
    };
    enforcer.enforce(user, rank);
    users[id] = user;
    return user.rank;
  };
  return Object.freeze(enforcer);
};
