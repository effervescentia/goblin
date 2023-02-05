import { expect } from 'chai';

import {
  Add,
  And,
  Argument,
  BooleanLiteral,
  DataReference,
  DiceRoll,
  Divide,
  Equal,
  Exponent,
  FileReference,
  FunctionCall,
  GreaterOrEqual,
  GreaterThan,
  Group,
  LessOrEqual,
  LessThan,
  Multiply,
  Negative,
  Not,
  NotEqual,
  NumberLiteral,
  Or,
  Reference,
  StringLiteral,
  Subtract,
} from '../../src/language/expression';
import { Language } from '../../src/language/parser';

describe('Language', () => {
  describe('parse literals', () => {
    it('should parse a boolean literal', () => {
      const result = Language.Expression.tryParse('true');

      expect(result).to.be.instanceOf(BooleanLiteral);
      expect((result as BooleanLiteral).value).to.eq(true);
    });

    it('should parse an integer literal', () => {
      const result = Language.Expression.tryParse('00123');

      expect(result).to.be.instanceOf(NumberLiteral);
      expect((result as NumberLiteral).value).to.eq(123);
    });

    it('should parse a float literal', () => {
      const result = Language.Expression.tryParse('12.34');

      expect(result).to.be.instanceOf(NumberLiteral);
      expect((result as NumberLiteral).value).to.eq(12.34);
    });

    it('should parse an empty string literal', () => {
      const result = Language.Expression.tryParse("''");

      expect(result).to.be.instanceOf(StringLiteral);
      expect((result as StringLiteral).value).to.eq('');
    });

    it('should parse a simple string literal', () => {
      const result = Language.Expression.tryParse("'foo'");

      expect(result).to.be.instanceOf(StringLiteral);
      expect((result as StringLiteral).value).to.eq('foo');
    });

    it('should parse an escaped string literal', () => {
      const result = Language.Expression.tryParse("'it\\'s'");

      expect(result).to.be.instanceOf(StringLiteral);
      expect((result as StringLiteral).value).to.eq("it's");
    });
  });

  describe('parse dice rolls', () => {
    it('should not parse count < 1', () => {
      const result = Language.Expression.parse('0d8');

      expect(result.status).to.be.false;
    });

    it('should not parse max < 2', () => {
      const result = Language.Expression.parse('2d1');

      expect(result.status).to.be.false;
    });

    it('should parse valid roll', () => {
      const result = Language.Expression.tryParse('3d6');

      expect(result).to.be.instanceOf(DiceRoll);
      expect((result as DiceRoll).count).to.eq(3);
      expect((result as DiceRoll).max).to.eq(6);
    });
  });

  describe('parse identifiers', () => {
    it('should parse an argument', () => {
      const result = Language.Expression.tryParse(':foo');

      expect(result).to.be.instanceOf(Argument);
      expect((result as Argument).name).to.eq('foo');
    });

    it('should parse a root file reference', () => {
      const result = Language.Expression.tryParse('@/foo');

      expect(result).to.be.instanceOf(FileReference);
      expect((result as FileReference).path).to.eql([
        FileReference.ROOT,
        'foo',
      ]);
    });

    it('should parse a nested file reference', () => {
      const result = Language.Expression.tryParse('@/foo/bar');

      expect(result).to.be.instanceOf(FileReference);
      expect((result as FileReference).path).to.eql([
        FileReference.ROOT,
        'foo',
        'bar',
      ]);
    });

    it('should parse a relative file reference', () => {
      const result = Language.Expression.tryParse('./foo');

      expect(result).to.be.instanceOf(FileReference);
      expect((result as FileReference).path).to.eql([Reference.SELF, 'foo']);
    });

    it('should parse a parent file reference', () => {
      const result = Language.Expression.tryParse('../foo');

      expect(result).to.be.instanceOf(FileReference);
      expect((result as FileReference).path).to.eql([Reference.PARENT, 'foo']);
    });

    it('should parse an ancestor file reference', () => {
      const result = Language.Expression.tryParse('../../foo');

      expect(result).to.be.instanceOf(FileReference);
      expect((result as FileReference).path).to.eql([
        Reference.PARENT,
        Reference.PARENT,
        'foo',
      ]);
    });

    it('should parse a root data reference', () => {
      const result = Language.Expression.tryParse('#foo');

      expect(result).to.be.instanceOf(DataReference);
      expect((result as DataReference).file).to.eq(FileReference.RELATIVE);
      expect((result as DataReference).path).to.eql([
        DataReference.ROOT,
        'foo',
      ]);
    });

    it('should parse a nested data reference', () => {
      const result = Language.Expression.tryParse('#foo.bar');

      expect(result).to.be.instanceOf(DataReference);
      expect((result as DataReference).file).to.eq(FileReference.RELATIVE);
      expect((result as DataReference).path).to.eql([
        DataReference.ROOT,
        'foo',
        'bar',
      ]);
    });

    it('should parse a relative data reference', () => {
      const result = Language.Expression.tryParse('.foo');

      expect(result).to.be.instanceOf(DataReference);
      expect((result as DataReference).file).to.eq(FileReference.RELATIVE);
      expect((result as DataReference).path).to.eql([Reference.SELF, 'foo']);
    });

    it('should parse a parent data reference', () => {
      const result = Language.Expression.tryParse('..foo');

      expect(result).to.be.instanceOf(DataReference);
      expect((result as DataReference).file).to.eq(FileReference.RELATIVE);
      expect((result as DataReference).path).to.eql([Reference.PARENT, 'foo']);
    });

    it('should parse an ancestor data reference', () => {
      const result = Language.Expression.tryParse('...foo');

      expect(result).to.be.instanceOf(DataReference);
      expect((result as DataReference).file).to.eq(FileReference.RELATIVE);
      expect((result as DataReference).path).to.eql([
        Reference.PARENT,
        Reference.PARENT,
        'foo',
      ]);
    });

    it('should parse an absolute file-data reference', () => {
      const result = Language.Expression.tryParse('@/foo/bar#fizz.buzz');

      expect(result).to.be.instanceOf(DataReference);
      expect((result as DataReference).file.path).to.eql([
        FileReference.ROOT,
        'foo',
        'bar',
      ]);
      expect((result as DataReference).path).to.eql([
        DataReference.ROOT,
        'fizz',
        'buzz',
      ]);
    });

    it('should parse a relative file-data reference', () => {
      const result = Language.Expression.tryParse('./foo/bar#fizz.buzz');

      expect(result).to.be.instanceOf(DataReference);
      expect((result as DataReference).file.path).to.eql([
        Reference.SELF,
        'foo',
        'bar',
      ]);
      expect((result as DataReference).path).to.eql([
        DataReference.ROOT,
        'fizz',
        'buzz',
      ]);
    });

    it('should parse a parent file-data reference', () => {
      const result = Language.Expression.tryParse('../foo/bar#fizz.buzz');

      expect(result).to.be.instanceOf(DataReference);
      expect((result as DataReference).file.path).to.eql([
        Reference.PARENT,
        'foo',
        'bar',
      ]);
      expect((result as DataReference).path).to.eql([
        DataReference.ROOT,
        'fizz',
        'buzz',
      ]);
    });
  });

  describe('parse operations', () => {
    it('should parse NOT operation', () => {
      const result = Language.Expression.tryParse('!true');

      expect(result).to.be.instanceOf(Not);
      expect((result as Not).expression).to.be.instanceOf(BooleanLiteral);
    });

    it('should parse NEGATIVE operation', () => {
      const result = Language.Expression.tryParse('-100');

      expect(result).to.be.instanceOf(Negative);
      expect((result as Negative).expression).to.be.instanceOf(NumberLiteral);
    });

    it('should parse multiple chained unary operations', () => {
      const result = Language.Expression.tryParse('!!true');

      expect(result).to.be.instanceOf(Not);
      expect((result as Not).expression).to.be.instanceOf(Not);
      expect(((result as Not).expression as Not).expression).to.be.instanceOf(
        BooleanLiteral,
      );
    });

    it('should parse EXPONENT operation right-to-left', () => {
      const result = Language.Expression.tryParse('10 ^ 5 ^ 2');

      expect(result).to.be.instanceOf(Exponent);
      expect((result as Exponent).lhs).to.be.instanceOf(NumberLiteral);
      expect((result as Exponent).rhs).to.be.instanceOf(Exponent);
    });

    it('should parse MULTIPLY operation left-to-right', () => {
      const result = Language.Expression.tryParse('10 * 5 * 2');

      expect(result).to.be.instanceOf(Multiply);
      expect((result as Multiply).lhs).to.be.instanceOf(Multiply);
      expect((result as Multiply).rhs).to.be.instanceOf(NumberLiteral);
    });

    it('should parse DIVIDE operation left-to-right', () => {
      const result = Language.Expression.tryParse('10 / 5 / 2');

      expect(result).to.be.instanceOf(Divide);
      expect((result as Divide).lhs).to.be.instanceOf(Divide);
      expect((result as Divide).rhs).to.be.instanceOf(NumberLiteral);
    });

    it('should parse ADD operation left-to-right', () => {
      const result = Language.Expression.tryParse('10 + 5 + 2');

      expect(result).to.be.instanceOf(Add);
      expect((result as Add).lhs).to.be.instanceOf(Add);
      expect((result as Add).rhs).to.be.instanceOf(NumberLiteral);
    });

    it('should parse SUBTRACT operation left-to-right', () => {
      const result = Language.Expression.tryParse('10 - 5 - 2');

      expect(result).to.be.instanceOf(Subtract);
      expect((result as Subtract).lhs).to.be.instanceOf(Subtract);
      expect((result as Subtract).rhs).to.be.instanceOf(NumberLiteral);
    });

    it('should parse LESS_THAN operation', () => {
      const result = Language.Expression.tryParse('10 < 5');

      expect(result).to.be.instanceOf(LessThan);
      expect((result as LessThan).lhs).to.be.instanceOf(NumberLiteral);
      expect((result as LessThan).rhs).to.be.instanceOf(NumberLiteral);
    });

    it('should parse LESS_OR_EQUAL operation', () => {
      const result = Language.Expression.tryParse('10 <= 5');

      expect(result).to.be.instanceOf(LessOrEqual);
      expect((result as LessOrEqual).lhs).to.be.instanceOf(NumberLiteral);
      expect((result as LessOrEqual).rhs).to.be.instanceOf(NumberLiteral);
    });

    it('should parse GREATER_THAN operation', () => {
      const result = Language.Expression.tryParse('10 > 5');

      expect(result).to.be.instanceOf(GreaterThan);
      expect((result as GreaterThan).lhs).to.be.instanceOf(NumberLiteral);
      expect((result as GreaterThan).rhs).to.be.instanceOf(NumberLiteral);
    });

    it('should parse GREATER_OR_EQUAL operation', () => {
      const result = Language.Expression.tryParse('10 >= 5');

      expect(result).to.be.instanceOf(GreaterOrEqual);
      expect((result as GreaterOrEqual).lhs).to.be.instanceOf(NumberLiteral);
      expect((result as GreaterOrEqual).rhs).to.be.instanceOf(NumberLiteral);
    });

    it('should parse EQUAL operation left-to-right', () => {
      const result = Language.Expression.tryParse('true == false == true');

      expect(result).to.be.instanceOf(Equal);
      expect((result as Equal).lhs).to.be.instanceOf(Equal);
      expect((result as Equal).rhs).to.be.instanceOf(BooleanLiteral);
    });

    it('should parse NOT_EQUAL operation left-to-right', () => {
      const result = Language.Expression.tryParse('true != false != true');

      expect(result).to.be.instanceOf(NotEqual);
      expect((result as NotEqual).lhs).to.be.instanceOf(NotEqual);
      expect((result as NotEqual).rhs).to.be.instanceOf(BooleanLiteral);
    });

    it('should parse AND operation left-to-right', () => {
      const result = Language.Expression.tryParse('true && false && true');

      expect(result).to.be.instanceOf(And);
      expect((result as And).lhs).to.be.instanceOf(And);
      expect((result as And).rhs).to.be.instanceOf(BooleanLiteral);
    });

    it('should parse OR operation left-to-right', () => {
      const result = Language.Expression.tryParse('true || false || true');

      expect(result).to.be.instanceOf(Or);
      expect((result as Or).lhs).to.be.instanceOf(Or);
      expect((result as Or).rhs).to.be.instanceOf(BooleanLiteral);
    });

    it('should respect operator precedence', () => {
      const result = Language.Expression.tryParse('10 + 2 * 4 >= 5 - 3 ^ 1');

      expect(result).to.be.instanceOf(GreaterOrEqual);
      expect((result as GreaterOrEqual).lhs).to.be.instanceOf(Add);
      expect((result as GreaterOrEqual).rhs).to.be.instanceOf(Subtract);
    });
  });

  describe('parse function calls', () => {
    it('should parse function call without arguments', () => {
      const result = Language.Expression.tryParse('.foo()');

      expect(result).to.be.instanceOf(FunctionCall);
      expect((result as FunctionCall).function_).to.be.instanceOf(
        DataReference,
      );
      expect((result as FunctionCall).arguments_).to.eql([]);
    });

    it('should parse function call with arguments', () => {
      const result = Language.Expression.tryParse('.foo(true, 123)');

      expect(result).to.be.instanceOf(FunctionCall);
      expect((result as FunctionCall).function_).to.be.instanceOf(
        DataReference,
      );
      expect((result as FunctionCall).arguments_).to.have.length(2);
      expect((result as FunctionCall).arguments_[0]).to.be.instanceOf(
        BooleanLiteral,
      );
      expect((result as FunctionCall).arguments_[1]).to.be.instanceOf(
        NumberLiteral,
      );
    });

    it('should parse nested function calls', () => {
      const result = Language.Expression.tryParse('.foo(#bar())');

      expect(result).to.be.instanceOf(FunctionCall);
      expect((result as FunctionCall).function_).to.be.instanceOf(
        DataReference,
      );
      expect((result as FunctionCall).arguments_).to.have.length(1);
      expect((result as FunctionCall).arguments_[0]).to.be.instanceOf(
        FunctionCall,
      );
    });
  });

  describe('parse groups', () => {
    it('should parse a single group', () => {
      const result = Language.Expression.tryParse('(10 + 3)');

      expect(result).to.be.instanceOf(Group);
      expect((result as Group).expression).to.be.instanceOf(Add);
    });

    it('should parse nested groups', () => {
      const result = Language.Expression.tryParse('(((10 + 3)))');

      expect(result).to.be.instanceOf(Group);
      expect((result as Group).expression).to.be.instanceOf(Group);
      expect(
        ((result as Group).expression as Group).expression,
      ).to.be.instanceOf(Group);
      expect(
        (((result as Group).expression as Group).expression as Group)
          .expression,
      ).to.be.instanceOf(Add);
    });
  });
});
