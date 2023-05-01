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
  let spirit = new TestState();

  beforeEach(function () {
    const plain = {
      num: 42,
      str: 'fourty two',
      strArr: ['one', 'two', 'tree'],
    };

    const TestShredder = new Shredder(plain);
    /* State based on a Shredder */
    spirit = Elf.Spirit.from(TestState)(TestShredder);
  });

  it('read one number', function () {
    expect(spirit.num).to.be.equal(42);
  });

  it('read one string', function () {
    expect(spirit.str).to.be.equal('fourty two');
  });

  it('read array string', function () {
    expect(spirit.strArr[0]).to.be.equal('one');
  });
});
