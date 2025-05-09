// @ts-check
'use strict';

const {expect} = require('chai');
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
  it('jonnyCases', async function () {
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
        expect(delta).to.be.greaterThan(1).and.to.be.lessThan(3);

        const counter = await api.getCounter();
        expect(counter).to.be.equals(1);
      } finally {
        await this.quest.kill(id);
      }
    });
  });
});
