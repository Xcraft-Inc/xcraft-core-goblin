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

  it('massiveCreateKill', async function () {
    this.timeout(60000);
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(
        this.quest.resp,
        ['test-goblin-core.js'],
        __dirname,
        {}
      );

      const desktopId = 'system@createKill';
      const id = `test-goblin-core@${this.quest.uuidV4()}`;

      const ck = async (cnt) => {
        for (let i = 0; i < 10; ++i) {
          await this.quest.create('test-goblin-core', {
            id,
            desktopId,
            wait: 0,
          });
          await this.quest.kill(id);
          cnt.value++;
        }
      };

      const cnt = {value: 1};
      let prev = 0;

      const deadlock = setInterval(() => {
        expect(cnt.value).to.be.not.equals(
          prev,
          `DEADLOCK: counter stopped at ${cnt.value}`
        );

        prev = cnt.value;
      }, 5000);

      try {
        for (let i = 0; i < 1000; ++i) {
          await ck(cnt);
        }

        clearInterval(deadlock);
      } finally {
        /* cleanup */
        await this.quest.kill(id);
      }
    });
  });
});
