// @ts-check
'use strict';

const {expect} = require('chai');
const {Elf} = require('xcraft-core-goblin/lib/test.js');
const {SimpleElf} = require('./simpleElf.js');

describe('xcraft.goblin.elf', function () {
  let runner;

  this.beforeAll(function () {
    runner = new Elf.Runner();
    runner.init();
  });

  this.afterAll(function () {
    runner.dispose();
  });

  it('local state read', async function () {
    this.timeout(10000);
    await runner.it(async function () {
      const xBus = require('xcraft-core-bus');
      await xBus.loadModule(this.quest.resp, ['simpleElf.js'], __dirname, {});

      const feedId = await this.newQuestFeed();
      const id = `simpleElf@${this.quest.uuidV4()}`;

      const simpleElf = await new SimpleElf(this).create(id, feedId, 'Hello');
      expect(simpleElf.state.value).to.be.equal('Hello');

      await simpleElf.update('Bonjour');
      expect(simpleElf.state.value).to.be.equal('Bonjour');
    });
  });
});
