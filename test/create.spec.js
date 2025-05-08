// @ts-check
'use strict';

const {Elf} = require('xcraft-core-goblin/lib/test.js');

describe('xcraft.goblin.create', function () {
  let runner;

  this.beforeAll(function () {
    runner = new Elf.Runner();
    runner.init();
  });

  this.afterAll(function () {
    runner.dispose();
  });

  /* The second create must return only when the first create has
   * finished. The first create waits for 2s (without await), the second
   * create waits for 500ms (await). The test must returned when the
   * counter is 1 (recreate is just waiting) and with a total time around 2s.
   */
  it('cases', async function () {
    this.timeout(10000);
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(
        this.quest.resp,
        ['test-goblin-core.js'],
        __dirname,
        {}
      );

      const desktopId = 'system@createCases';
      const id = `test-goblin-core@${this.quest.uuidV4()}`;
      const start = process.hrtime();
      try {
        this.quest.create('test-goblin-core', {
          id,
          desktopId,
          wait: 2000,
        });
        const api = await this.quest.create('test-goblin-core', {
          id,
          desktopId,
          wait: 500,
        });

        const delta = process.hrtime(start)[0];
        if (delta < 2 || delta > 3) {
          throw new Error(
            `Failed because creates must take more than 2s and less than 3s, received ${delta}`
          );
        }

        const counter = await api.getCounter();
        if (counter !== 1) {
          throw new Error(
            `Failed because the counter should be 1 and received ${counter}`
          );
        }
      } finally {
        await this.quest.kill(id);
      }
    });
  });
});
