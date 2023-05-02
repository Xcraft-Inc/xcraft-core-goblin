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
    numArr = array(number);
    strArr = array(string);
  }

  class TestState extends Elf.Sculpt(TestShape) {}
  let spirit = new TestState();

  beforeEach(function () {
    const plain = {
      num: 42,
      str: 'fourty two',
      numArr: [10, 20, 30, 40],
      strArr: ['one', 'two', 'three'],
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

  it('read array number', function () {
    expect(spirit.numArr[0]).to.be.equal(10);
    expect(spirit.numArr[1]).to.be.equal(20);
    expect(spirit.numArr[2]).to.be.equal(30);
    expect(spirit.numArr[3]).to.be.equal(40);
  });

  it('read array string', function () {
    expect(spirit.strArr[0]).to.be.equal('one');
    expect(spirit.strArr[1]).to.be.equal('two');
    expect(spirit.strArr[2]).to.be.equal('three');
  });

  it('read array length', function () {
    expect(spirit.numArr.length).to.be.equal(4);
    expect(spirit.strArr.length).to.be.equal(3);
  });
});
