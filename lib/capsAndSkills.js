'use strict';
//////////////////////////////////////////////////////////////////////////////
//private mapping
const capStore = {};
const capEnabled = new WeakMap();
const capDisabled = new WeakMap();
const contracts = new WeakMap();

///////////////////////////////////////////////////////////////////////////////
// SKILLS SET
// define capabilities needed to deal with a ref (contracts)
//
///////////////////////////////////////////////////////////////////////////////
class SkillsSet {
  static define(refToProtect, skills) {
    const def = {
      isCapable: (goblin) => {
        if (capStore[Symbol.for('*')].get(goblin)) {
          return true;
        }
        return skills.every((skill) => {
          if (!capStore[skill]) {
            //skill not assigned in def!
            return false;
          }
          const cap = capStore[skill].get(goblin);
          if (capEnabled.get(cap)) {
            return cap.name === skill;
          } else {
            return false;
          }
        });
      },
    };

    Object.freeze(def);
    contracts.set(refToProtect, def);
    return def;
  }
}

Object.freeze(SkillsSet);

///////////////////////////////////////////////////////////////////////////////
// CAPABILITY
// define a capability
//
//
///////////////////////////////////////////////////////////////////////////////
class Capability {
  static create(goblin, name, delegatable = false, owner = null) {
    if (!goblin.id) {
      throw new Error('Missing object identifier');
    }
    let delegatedTo = null;
    if (!owner) {
      owner = goblin.id;
    } else {
      delegatedTo = goblin.id;
    }
    const cap = {owner, name, delegatable, delegatedTo};
    if (delegatedTo) {
      cap.revoke = () => Capability.delete(cap);
    }
    Object.freeze(cap);
    if (!capStore[name]) {
      capStore[name] = new WeakMap();
    }
    capStore[name].set(goblin, cap);
    Capability.enable(cap);
    return cap;
  }

  static delegate(cap, goblin, ttl = 0, delegatable = false) {
    if (!cap.delegatable) {
      throw new Error('Delegation error');
    }
    const delegateCap = Capability.create(
      goblin,
      cap.name,
      delegatable,
      cap.owner
    );
    if (ttl > 0) {
      setTimeout(() => Capability.delete(delegateCap), ttl);
    }
    return delegateCap;
  }

  static enable(cap) {
    if (capEnabled.has(cap)) {
      return;
    }
    if (capDisabled.has(cap)) {
      capDisabled.delete(cap);
    }
    capEnabled.set(cap, cap);
  }

  static disable(cap) {
    if (capDisabled.has(cap)) {
      return;
    }
    if (capEnabled.has(cap)) {
      capEnabled.delete(cap);
    }
    capDisabled.set(cap, cap);
  }

  static fulfill(goblin, quest) {
    if (contracts.has(quest)) {
      const def = contracts.get(quest);
      return def.isCapable(goblin);
    } else {
      //if no def is found on goblin (unsecure) we accept
      return true;
    }
  }
}
Object.freeze(Capability);

const capAndSkills = {
  Capability,
  SkillsSet,
};

module.exports = capAndSkills;
