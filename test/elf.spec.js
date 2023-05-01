// @ts-check
'use strict';

const xHost = require('xcraft-core-host');
// @ts-ignore
process.env.XCRAFT_ROOT = xHost.appConfigPath;

const {expect} = require('chai');
const {Elf, Shredder} = require('xcraft-core-goblin');
const {number, string, array} = require('xcraft-core-stones');

describe("Elf's spirit", function () {
  class TestShape {
    num = number;
    str = string;
    strArr = array(string);
  }

  class TestState extends Elf.Sculpt(TestShape) {}
  let spirit0 = new TestState();
  let spirit1 = new TestState();

  beforeEach(function () {
    const plain = {
      num: 42,
      str: 'fourty two',
      strArr: ['one', 'two', 'tree'],
    };

    /* State based on a plain javascript object */
    spirit0 = new TestState(plain);

    const TestShredder = new Shredder(plain);
    /* State based on a Shredder */
    spirit1 = Elf.Spirit.from(TestState)(TestShredder);
  });

  it('read one number', function () {
    expect(spirit0.num).to.be.equal(42);
    expect(spirit1.num).to.be.equal(42);
  });

  it('read one string', function () {
    expect(spirit0.str).to.be.equal('fourty two');
    expect(spirit1.str).to.be.equal('fourty two');
  });

  it('read array string', function () {
    expect(spirit0.strArr[0]).to.be.equal('one');
    expect(spirit1.strArr[0]).to.be.equal('one');
  });
});
