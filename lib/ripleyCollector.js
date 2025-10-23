// @ts-check
const Goblin = require('./index.js');
const {Elf} = Goblin;

async function asyncFilter(array, predicate) {
  const results = await Promise.all(array.map(predicate));
  return array.filter((_, index) => results[index]);
}

function getAllRefs(actorId, references) {
  return Array.from(
    new Set(
      Array.from(references.get(actorId)).concat(
        /* Get references by SmartId inherit */
        Array.from(references.keys()).filter((id) => id.includes(actorId))
      )
    )
  ).filter((id) => id !== actorId);
}

class RipleyCollector extends Elf.Alone {
  _references = new Map();

  async _populateGraph() {
    const types = Goblin.getAllRipleyActors();
    const patterns = types.map((type) => `*${type}@*`);

    /* Populate the references Map
     * Extract ${type}@ from raw actions (don't work with JSON,
     * just strings). It extracts everything even in previous 'persist'
     * actions, not only in the latest.
     */
    const searchFor = async (db) => {
      const results = this.cryo.searchRaw(db, patterns, /([\w\-@%]+)/g, {
        last: false,
      });
      for await (const {id, refs} of results) {
        for (const refId of refs) {
          if (!types.includes(refId.split('@', 1)[0])) {
            continue;
          }
          if (!this._references.has(refId)) {
            this._references.set(refId, new Set());
          }
          if (refId === id) {
            continue;
          }
          const ids = this._references.get(refId);
          ids.add(id);
        }
      }
    };

    const dbs = Goblin.getAllRipleyDB();
    for (const db of dbs) {
      await searchFor(db);
    }
  }

  async _trashOrphans(type) {
    const actorDB = Goblin.getActorRipleyDB(type);

    /* Filter only trashed actors */
    const actorIds = await this.cryo.getIds(actorDB, type);
    const trashed = await asyncFilter(
      Array.from(actorIds),
      async (actorId) => !(await this.cryo.isPublished(actorDB, actorId))
    );

    if (!trashed.length) {
      this.log.dbg(`No trashed detected, nothing to collect`);
      return; /* All actors are published */
    }

    const orphans = new Set();

    for (const trashId of trashed) {
      /* Extract the list of trashed orphans (trashed without reference) */
      if (!this._references.has(trashId)) {
        orphans.add(trashId);
        continue;
      }

      /* Handle circular references, for example a trashed 'case' has a reference
       * on a published 'businessEvent' and this 'businessEvent' has a reference
       * on the 'case'.
       * If this 'businessEvent' is not referenced elsewhere excepted the trashed
       * 'case', then it's a candidate to be trashed too.
       */
      const refIds = getAllRefs(trashId, this._references);
      for (const refId of refIds) {
        const ids = getAllRefs(refId, this._references);
        if (!ids.length) {
          orphans.add(refId);
        }
      }
    }

    this.log.dbg('@@@', type, '' + orphans.size);

    /* List orphans */
    for (const orphanId of orphans) {
      /* FIXME: Trash this orphan */
      this.log.dbg('→ ', orphanId);
    }
  }

  async run() {
    await this._populateGraph();

    for (const type of Goblin.getAllRipleyActors()) {
      await this._trashOrphans(type);
    }
  }
}

module.exports = {RipleyCollector};
