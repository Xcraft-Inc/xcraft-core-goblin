// @ts-check
'use strict';

const {expect} = require('chai');
const {Elf, Shredder} = require('xcraft-core-goblin/lib/test.js');
const {number, string, array, option} = require('xcraft-core-stones');
const {logicTraps} = require('../lib/elf/traps.js');
const {cacheReduceParams} = require('../lib/elf/params.js');

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
        objArr: [],
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
      expect(spirit.str).is.equals('');
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
      expect(spirit.numArr.includes(42)).to.be.equals(false);
      spirit.numArr.push(42);
      expect(spirit.numArr.includes(42)).to.be.equals(true);
    });

    it('array map number', function () {
      expect(spirit.numArr).to.have.lengthOf(0);
      spirit.numArr.push(21);
      spirit.numArr.push(42);
      const numArr = spirit.numArr.map((nb) => nb * 2);
      expect(numArr[0]).to.be.equal(42);
      expect(numArr[1]).to.be.equal(84);
    });

    it('array map string', function () {
      expect(spirit.strArr).to.have.lengthOf(0);
      spirit.strArr.push('4');
      spirit.strArr.push('4');
      const strArr = spirit.strArr.map((str, index) => str + `${index + 2}`);
      expect(strArr[0]).to.be.equal('42');
      expect(strArr[1]).to.be.equal('43');
    });

    it('array map object', function () {
      expect(spirit.objArr).to.have.lengthOf(0);
      spirit.objArr.push({knight: 'Bragon', princess: 'Mara'});
      spirit.objArr.push({knight: 'Rige', princess: 'unknown'});
      const objArr = spirit.objArr.map((obj) => obj.knight);
      expect(objArr[0]).to.be.equal('Bragon');
      expect(objArr[1]).to.be.equal('Rige');
    });

    it('array', function () {
      expect(spirit.numArr[0]).to.be.equals(undefined);
      expect(spirit.numArr[1]).to.be.equals(undefined);
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
      expect(spirit.obj.knight).satisfies((str) => typeof str === 'string');
      expect(spirit.obj.princess).satisfies((str) => typeof str === 'string');
      expect(spirit.obj.master).satisfies((str) => typeof str === 'string');
      delete spirit.obj.master;
      expect(spirit.obj.knight).satisfies((str) => typeof str === 'string');
      expect(spirit.obj.princess).satisfies((str) => typeof str === 'string');
      expect(spirit.obj.master).is.equals(undefined);
    });
  });
});

describe('xcraft.goblin.elf.traps', function () {
  describe('logic.do', function () {
    const goblinName = 'myGoblin';
    const questName = 'myReducer';

    let payload;

    const target = {
      name: questName,
    };
    const self = {
      _quest: {
        goblin: {
          goblinName,
        },
        questName,
        msg: {
          data: {},
        },
        do: (p) => {
          payload = p;
        },
        dispatch: (n, p) => {
          payload = p;
        },
      },
    };
    const params = ['arg1', 'arg2', 'arg3', 'arg4'];

    cacheReduceParams.register(goblinName, questName, params);

    it('empty (no overload)', function () {
      const args = ['data 1', 'data 2', 'data 3'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (first)', function () {
      const args = ['data 4'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg1: 'data 4'};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (first two)', function () {
      const args = ['data 4', 'data 5'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg1: 'data 4', arg2: 'data 5'};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (all)', function () {
      const args = ['data 4', 'data 5', 'data 6'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg1: 'data 4', arg2: 'data 5', arg3: 'data 6'};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (first with null)', function () {
      const args = [null];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg1: null};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (first two with null)', function () {
      const args = [null, null];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg1: null, arg2: null};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (all with null)', function () {
      const args = [null, null, null];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg1: null, arg2: null, arg3: null};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (first with undefined)', function () {
      const args = [undefined];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (first two with undefined)', function () {
      const args = [undefined, undefined];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (all with undefined)', function () {
      const args = [undefined, undefined, undefined];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (extend)', function () {
      const args = ['data 1', 'data 2', 'data 3', 'data X'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg4: 'data X'};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (first and extend)', function () {
      const args = ['data 4', 'data 2', 'data 3', 'data X'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg1: 'data 4', arg4: 'data X'};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (first two and extend)', function () {
      const args = ['data 4', null, 'data 3', 'data X'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg1: 'data 4', arg2: null, arg4: 'data X'};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('overload (extend undefined)', function () {
      const args = ['data 1', 'data 2', 'data 3', undefined];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });
  });

  describe('logic.dispatch', function () {
    const goblinName = 'myGoblin';
    const myReducer = 'myReducer';
    const mySecondReducer = 'mySecondReducer';

    let payload;

    const target = {
      name: mySecondReducer,
    };
    const self = {
      _quest: {
        goblin: {
          goblinName,
        },
        questName: myReducer,
        msg: {
          data: {},
        },
        do: (p) => {
          payload = p;
        },
        dispatch: (n, p) => {
          payload = p;
        },
      },
    };
    const params1 = ['arg1', 'arg2', 'arg3', 'arg4'];
    const params2 = ['arg2', 'arg5'];

    cacheReduceParams.register(goblinName, myReducer, params1);
    cacheReduceParams.register(goblinName, mySecondReducer, params2);

    it('empty (nothing)', function () {
      const args = [];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('forward (second)', function () {
      const args = ['data 2'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg2: 'data 2'};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });

    it('forward (all)', function () {
      const args = ['data 2', 'data 5'];
      const data = {arg1: 'data 1', arg2: 'data 2', arg3: 'data 3'};
      const expected = {arg2: 'data 2', arg5: 'data 5'};

      self._quest.msg.data = data;
      logicTraps.apply(target, self, args);
      expect(payload).to.be.eql(expected);
    });
  });
});
