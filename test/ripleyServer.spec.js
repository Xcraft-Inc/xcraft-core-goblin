const {expect} = require('chai');
const {Elf} = require('xcraft-core-goblin/lib/test.js');
const {SimpleElfLogic} = require('./simpleElf.js');

describe('xcraft.goblin.elf.ripley', function () {
  let runner;

  this.beforeAll(function () {
    runner = new Elf.Runner();
    runner.init();
  });

  this.afterAll(function () {
    runner.dispose();
  });

  /// ripleyCheckForCommitId ///////////////////////////////////////////////////

  it('ripleyCheckForCommitId returns check=true when server is empty', async function () {
    this.timeout(5000);

    /** @this {Elf} */
    await runner.it(async function () {
      const result = await this.quest.cmd('goblin.ripleyCheckForCommitId', {
        db: 'test-empty',
        commitIds: ['some-unknown-id'],
      });
      expect(result.check).to.be.equal(true);
      expect(result.count).to.be.equal(0);
    });
  });

  it('ripleyCheckForCommitId returns check=false for unknown commitId on non-empty server', async function () {
    this.timeout(10000);

    /** @this {Elf} */
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const db = SimpleElfLogic.db;
      const id = `simpleElf@${this.quest.uuidV4()}`;

      const action = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Chevalier Bragon'},
          meta: {id},
        }),
      };

      await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [action],
        commitIds: [],
        userId: 'user@test',
      });

      const result = await this.quest.cmd('goblin.ripleyCheckForCommitId', {
        db,
        commitIds: ['totally-unknown-commitid'],
      });
      expect(result.check).to.be.equal(false);
    });
  });

  it('ripleyCheckForCommitId returns check=true for known commitId', async function () {
    this.timeout(10000);

    /** @this {Elf} */
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const db = SimpleElfLogic.db;
      const id = `simpleElf@${this.quest.uuidV4()}`;

      const action = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Chevalier Bragon'},
          meta: {id},
        }),
      };

      const result1 = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [action],
        commitIds: [],
        userId: 'user@test',
      });

      /* Known commitId → check=true */
      const result2 = await this.quest.cmd('goblin.ripleyCheckForCommitId', {
        db,
        commitIds: [result1.newCommitId],
      });
      expect(result2.check).to.be.equal(true);
      expect(result2.count).to.be.equal(0); /* Nothing new */
    });
  });

  it('ripleyCheckForCommitId falls back to second commitId if first is unknown', async function () {
    this.timeout(10000);

    /** @this {Elf} */
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const db = SimpleElfLogic.db;
      const id = `simpleElf@${this.quest.uuidV4()}`;

      const action = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Chevalier Bragon'},
          meta: {id},
        }),
      };

      const result1 = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [action],
        commitIds: [],
        userId: 'user@test',
      });

      const result2 = await this.quest.cmd('goblin.ripleyCheckForCommitId', {
        db,
        commitIds: ['unknown-newer-id', result1.newCommitId],
      });

      /* Le deuxième est connu → check=true */
      expect(result2.check).to.be.equal(true);
    });
  });

  /// ripleyServer /////////////////////////////////////////////////////////////

  it('ripleyServer assigns a commitId to staged actions', async function () {
    this.timeout(15000);

    /** @this {Elf} */
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const db = SimpleElfLogic.db;
      const id = `simpleElf@${this.quest.uuidV4()}`;

      /* Simulate non-persist action (commitId null) */
      const action = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Chevalier Bragon'},
          meta: {id},
        }),
      };

      const result = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [action],
        commitIds: [],
        userId: 'user@test',
      });

      expect(result).to.have.property('newCommitId');
      expect(result.newCommitId).to.be.a('string');
      expect(result.persisted).to.be.an('array').with.length(1);
      expect(result.persisted[0].data.commitId).to.equal(result.newCommitId);
    });
  });

  it('ripleyServer rejects unknown database', async function () {
    this.timeout(5000);

    /** @this {Elf} */
    await runner.it(async function () {
      try {
        await this.quest.cmd('goblin.ripleyServer', {
          db: 'not-authorized-db',
          actions: [],
          commitIds: [],
          userId: 'user@test',
        });
        expect.fail('Should have thrown');
      } catch (ex) {
        expect(ex.message).to.include('reject database');
      }
    });
  });

  it('ripleyServer is idempotent on re-sync', async function () {
    this.timeout(15000);

    /** @this {Elf} */
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const db = SimpleElfLogic.db;
      const id = `simpleElf@${this.quest.uuidV4()}`;

      const action = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Chevalier Bragon'},
          meta: {id},
        }),
      };

      const result1 = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [action],
        commitIds: [],
        userId: 'user@test',
      });

      /* Replay with the received commitId */
      const result2 = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [],
        commitIds: [result1.newCommitId],
        userId: 'user@test',
      });

      /* No new commit */
      expect(result2.newCommitId).to.be.equal(null);
      expect(result2.persisted).to.be.an('array').with.length(0);
    });
  });

  it('ripleyServer handles multiple goblins in one batch', async function () {
    this.timeout(15000);

    /** @this {Elf} */
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const db = SimpleElfLogic.db;
      const id1 = `simpleElf@${this.quest.uuidV4()}`;
      const id2 = `simpleElf@${this.quest.uuidV4()}`;

      const action1 = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Chevalier Bragon'},
          meta: {id: id1},
        }),
      };
      const action2 = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Princesse Mara'},
          meta: {id: id2},
        }),
      };

      const result = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [action1, action2],
        commitIds: [],
        userId: 'user@test',
      });

      /* Both elves must be persisted with the same commitId */
      expect(result.persisted).to.have.length(2);
      const commitIds = result.persisted.map((p) => p.data.commitId);
      expect(commitIds[0]).to.be.equal(commitIds[1]);
      expect(commitIds[0]).to.be.equal(result.newCommitId);
    });
  });

  it('ripleyServer returns missing persists when client commitId is known but outdated', async function () {
    this.timeout(15000);

    /** @this {Elf} */
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const db = SimpleElfLogic.db;
      const id1 = `simpleElf@${this.quest.uuidV4()}`;
      const id2 = `simpleElf@${this.quest.uuidV4()}`;

      const action1 = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Chevalier Bragon'},
          meta: {id: id1},
        }),
      };
      const action2 = {
        action: JSON.stringify({
          type: 'update',
          payload: {value: 'Princesse Mara'},
          meta: {id: id2},
        }),
      };

      /* Sync 1 : the client sends actions, received commitId1 */
      const result1 = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [action1],
        commitIds: [],
        userId: 'user@test',
      });
      const commitId1 = result1.newCommitId;

      /* Sync 2 : the other client sends other actions */
      await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [action2],
        commitIds: [],
        userId: 'user@test',
      });

      /* The first client re-syncs with its old commitId */
      const result3 = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [],
        commitIds: [commitId1],
        userId: 'user@test',
      });

      /* The first client must receive action2 */
      expect(result3.xcraftStream.streamId).to.be.a('string').with.length.gt(0);
      expect(result3.count).to.be.equal(1);
    });
  });

  it('ripleyServer updates an already persisted goblin', async function () {
    this.timeout(15000);

    /** @this {Elf} */
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const db = SimpleElfLogic.db;
      const id = `simpleElf@${this.quest.uuidV4()}`;

      const makeAction = (value) => ({
        action: JSON.stringify({
          type: 'update',
          payload: {value},
          meta: {id},
        }),
      });

      /* First sync: create the elf */
      const result1 = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [makeAction('v1')],
        commitIds: [],
        userId: 'user@test',
      });

      /* Second sync: update the same elf */
      const result2 = await this.quest.cmd('goblin.ripleyServer', {
        db,
        actions: [makeAction('v2')],
        commitIds: [result1.newCommitId],
        userId: 'user@test',
      });

      expect(result2.newCommitId).to.be.a('string');
      expect(result2.newCommitId).to.not.equal(result1.newCommitId);
      expect(result2.persisted).to.have.length(1);

      /* Check that the final state is v2 */
      const state = JSON.parse(result2.persisted[0].data.action);
      expect(state.payload.state.value).to.equal('v2');
    });
  });

  //////////////////////////////////////////////////////////////////////////////

  it('tryShutdown without active sync returns null', async function () {
    this.timeout(5000);

    /** @this {Elf} */
    await runner.it(async function () {
      const result = await this.quest.cmd('goblin.tryShutdown', {wait: false});
      expect(result).to.be.equal(null);
    });
  });
});
