// @ts-check
'use strict';

if (!process.env.XCRAFT_ROOT) {
  const fs = require('fs');
  const xHost = require('xcraft-core-host');
  // @ts-ignore
  process.env.XCRAFT_ROOT = fs.existsSync(xHost.appConfigPath)
    ? xHost.appConfigPath
    : xHost.projectPath;
}

const {expect} = require('chai');
const {Elf, Shredder} = require('xcraft-core-goblin');
const {number, string, array, option} = require('xcraft-core-stones');

describe('xcraft.goblin.elf.spirit', function () {
  class TestSubShape {
    knight = string;
    princess = string;
    master = option(string);
  }

  class TestShape {
    num = number;
    str = string;
    numArr = array(number);
    strArr = array(string);
    obj = TestSubShape;
    objArr = array(TestSubShape);
  }

  class TestState extends Elf.Sculpt(TestShape) {}
  let spirit = new TestState();

  describe('read', function () {
    before(function () {
      const plain = {
        num: 42,
        str: 'fourty two',
        numArr: [10, 20, 30, 40],
        strArr: ['one', 'two', 'three'],
        obj: {
          knight: 'Bragon',
          princess: 'Mara',
          master: 'Rige',
        },
        objArr: [
          {
            knight: 'Bragon 1',
            princess: 'Mara 1',
            master: 'Rige 1',
          },
          {
            knight: 'Bragon 2',
            princess: 'Mara 2',
            master: 'Rige 2',
          },
          2,
          '3',
        ],
      };

      const testShredder = new Shredder(plain);
      testShredder._state = testShredder._state.asMutable();
      spirit = Elf.Spirit.from(TestState)(testShredder);
    });

    it('one number', function () {
      expect(spirit.num).to.be.equal(42);
    });

    it('one string', function () {
      expect(spirit.str).to.be.equal('fourty two');
    });

    it('array number', function () {
      expect(spirit.numArr[0]).to.be.equal(10);
      expect(spirit.numArr[1]).to.be.equal(20);
      expect(spirit.numArr[2]).to.be.equal(30);
      expect(spirit.numArr[3]).to.be.equal(40);
    });

    it('array string', function () {
      expect(spirit.strArr[0]).to.be.equal('one');
      expect(spirit.strArr[1]).to.be.equal('two');
      expect(spirit.strArr[2]).to.be.equal('three');
    });

    it('array length', function () {
      expect(spirit.numArr).to.have.lengthOf(4);
      expect(spirit.strArr).to.have.lengthOf(3);
    });

    it('for..of on array', function () {
      let loop;

      loop = 1;
      for (const num of spirit.numArr) {
        expect(num).to.be.equal(10 * loop++);
      }

      const results = ['one', 'two', 'three'];
      loop = 0;
      for (const num of spirit.strArr) {
        expect(num).to.be.equal(results[loop++]);
      }
    });

    it('for..of on array of objects', function () {
      let loop = 0;
      for (const obj of spirit.objArr) {
        switch (loop) {
          case 0:
          case 1: {
            const num = loop === 0 ? '1' : '2';
            expect(obj.knight).to.be.equal(`Bragon ${num}`);
            expect(obj.princess).to.be.equal(`Mara ${num}`);
            expect(obj.master).to.be.equal(`Rige ${num}`);
            break;
          }
          case 2:
            expect(obj).to.be.equal(2);
            break;
          case 3:
            expect(obj).to.be.equal('3');
            break;
        }
        ++loop;
      }
    });

    it('for..of on object', function () {
      for (const key of Object.keys(spirit.obj)) {
        expect(key).to.be.oneOf(['knight', 'princess', 'master']);
      }

      for (const value of Object.values(spirit.obj)) {
        expect(value).to.be.oneOf(['Bragon', 'Mara', 'Rige']);
      }
    });
  });

  describe('write', function () {
    beforeEach(function () {
      const plain = {
        num: 0,
        str: '',
        numArr: [],
        strArr: [],
        obj: {
          knight: '',
          princess: '',
          master: '',
        },
      };

      const testShredder = new Shredder(plain);
      testShredder._state = testShredder._state.asMutable();
      spirit = Elf.Spirit.from(TestState)(testShredder);
    });

    it('one number', function () {
      expect(spirit.num).to.be.equal(0);
      spirit.num = 42;
      expect(spirit.num).to.be.equal(42);
    });

    it('one string', function () {
      expect(spirit.str).is.empty;
      spirit.str = 'fourty two';
      expect(spirit.str).to.be.equal('fourty two');
    });

    it('array number', function () {
      spirit.numArr.push(10);
      spirit.numArr.push(20);
      spirit.numArr.push(30);
      spirit.numArr.push(40);
      expect(spirit.numArr[0]).to.be.equal(10);
      expect(spirit.numArr[1]).to.be.equal(20);
      expect(spirit.numArr[2]).to.be.equal(30);
      expect(spirit.numArr[3]).to.be.equal(40);
    });

    it('array string', function () {
      spirit.strArr.push('one');
      spirit.strArr.push('two');
      spirit.strArr.push('three');
      expect(spirit.strArr[0]).to.be.equal('one');
      expect(spirit.strArr[1]).to.be.equal('two');
      expect(spirit.strArr[2]).to.be.equal('three');
    });

    it('array length', function () {
      expect(spirit.numArr).to.have.lengthOf(0);
      spirit.numArr.push(42);
      expect(spirit.numArr).to.have.lengthOf(1);

      expect(spirit.strArr).to.have.lengthOf(0);
      spirit.strArr.push('fourty two');
      expect(spirit.strArr).to.have.lengthOf(1);
    });

    it('array includes', function () {
      expect(spirit.numArr.includes(42)).to.be.false;
      spirit.numArr.push(42);
      expect(spirit.numArr.includes(42)).to.be.true;
    });

    it('array', function () {
      expect(spirit.numArr[0]).to.be.undefined;
      expect(spirit.numArr[1]).to.be.undefined;
      spirit.numArr = [1, 2];
      expect(spirit.numArr[0]).to.be.equal(1);
      expect(spirit.numArr[1]).to.be.equal(2);
    });

    it('object', function () {
      expect(spirit.obj).to.deep.equal({
        knight: '',
        princess: '',
        master: '',
      });
      spirit.obj = {
        knight: 'Bragon',
        princess: 'Mara',
        master: 'Rige',
      };
      expect(spirit.obj.knight).to.be.equal('Bragon');
      expect(spirit.obj.princess).to.be.equal('Mara');
      expect(spirit.obj.master).to.be.equal('Rige');
    });
  });

  describe('delete', function () {
    beforeEach(function () {
      const plain = {
        num: 42,
        str: 'fourty two',
        numArr: [10, 20, 30, 40],
        strArr: ['one', 'two', 'three'],
        obj: {
          knight: 'Bragon',
          princess: 'Mara',
          master: 'Rige',
        },
      };

      const testShredder = new Shredder(plain);
      testShredder._state = testShredder._state.asMutable();
      spirit = Elf.Spirit.from(TestState)(testShredder);
    });

    it('one deep key', function () {
      expect(spirit.obj.master).to.exist;
      delete spirit.obj.master;
      expect(spirit.obj.master).to.not.exist;
    });
  });
});
