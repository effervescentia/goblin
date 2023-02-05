import { expect } from 'chai';

import {
  ArrayNode,
  BooleanNode,
  EnumMacro,
  ExpressionNode,
  FunctionMacro,
  InitializeMacro,
  Node,
  NumberNode,
  ObjectNode,
  ParameterMacro,
  StringNode,
  TemplateMacro,
  TypeMacro,
} from '../../src/models/node';

describe('Node', () => {
  describe('#from()', () => {
    it('should extract a boolean node', () => {
      const result = Node.from(true);

      expect(result).to.be.instanceOf(BooleanNode);
      expect((result as BooleanNode).value).to.eq(true);
    });

    it('should extract a number node', () => {
      const result = Node.from(123);

      expect(result).to.be.instanceOf(NumberNode);
      expect((result as NumberNode).value).to.eq(123);
    });

    it('should extract a string node', () => {
      const result = Node.from('foo');

      expect(result).to.be.instanceOf(StringNode);
      expect((result as StringNode).value).to.eq('foo');
    });

    it('should extract an array node', () => {
      const result = Node.from([true, 123, 'foo']);

      expect(result).to.be.instanceOf(ArrayNode);
      expect((result as ArrayNode).items).to.have.length(3);
      expect((result as ArrayNode).items[0]).to.be.instanceOf(BooleanNode);
      expect((result as ArrayNode).items[1]).to.be.instanceOf(NumberNode);
      expect((result as ArrayNode).items[2]).to.be.instanceOf(StringNode);
    });

    it('should extract an object node', () => {
      const result = Node.from({ foo: true, bar: 123 });

      expect(result).to.be.instanceOf(ObjectNode);
      expect((result as ObjectNode).properties)
        .property('foo')
        .to.be.instanceOf(BooleanNode);
      expect((result as ObjectNode).properties)
        .property('bar')
        .to.be.instanceOf(NumberNode);
    });

    it('should extract an enum macro', () => {
      const result = Node.from({
        $enum: ['foo', 'bar'],
      });

      expect(result).to.be.instanceOf(EnumMacro);
      expect((result as EnumMacro).variants).to.have.length(2);
      expect((result as EnumMacro).variants[0]).to.be.instanceOf(StringNode);
      expect((result as EnumMacro).variants[1]).to.be.instanceOf(StringNode);
    });

    it('should extract a type literal macro', () => {
      const result = Node.from({ $type: 'string' });

      expect(result).to.be.instanceOf(TypeMacro);
      expect((result as TypeMacro).type).to.be.instanceOf(StringNode);
    });

    it('should extract a type reference macro', () => {
      const result = Node.from({ $type: '{@/types/foo}' });

      expect(result).to.be.instanceOf(TypeMacro);
      expect((result as TypeMacro).type).to.be.instanceOf(ExpressionNode);
    });

    it('should extract a function macro without parameters', () => {
      const result = Node.from({
        $func: '{1 + 2}',
      });

      expect(result).to.be.instanceOf(FunctionMacro);
      expect((result as FunctionMacro).parameters).to.eql({});
      expect((result as FunctionMacro).template).to.be.instanceOf(
        ExpressionNode,
      );
    });

    it('should extract a function macro with parameters', () => {
      const result = Node.from({
        ':lhs': { $type: 'number' },
        ':rhs': { $type: 'number' },
        $func: '{:lhs + :rhs}',
      });

      expect(result).to.be.instanceOf(FunctionMacro);
      expect((result as FunctionMacro).parameters)
        .property('lhs')
        .to.be.instanceOf(ParameterMacro);
      expect((result as FunctionMacro).parameters)
        .property('rhs')
        .to.be.instanceOf(ParameterMacro);
      expect((result as FunctionMacro).template).to.be.instanceOf(
        ExpressionNode,
      );
    });

    it('should extract a template macro without parameters', () => {
      const result = Node.from({
        $tmpl: { foo: 'bar' },
      });

      expect(result).to.be.instanceOf(TemplateMacro);
      expect((result as TemplateMacro).parameters).to.eql({});
      expect((result as TemplateMacro).template).to.be.instanceOf(ObjectNode);
    });

    it('should extract a template macro with parameters', () => {
      const result = Node.from({
        ':foo': { $type: 'string' },
        ':bar': { $type: 'string' },
        $tmpl: {
          foo: '{:foo}',
          bar: '{:bar}',
        },
      });

      expect(result).to.be.instanceOf(TemplateMacro);
      expect((result as TemplateMacro).parameters)
        .property('foo')
        .to.be.instanceOf(ParameterMacro);
      expect((result as TemplateMacro).parameters)
        .property('bar')
        .to.be.instanceOf(ParameterMacro);
      expect((result as TemplateMacro).template).to.be.instanceOf(ObjectNode);
    });

    it('should extract an initialization macro without arguments', () => {
      const result = Node.from({
        $init: '{@/templates/foo}',
      });

      expect(result).to.be.instanceOf(InitializeMacro);
      expect((result as InitializeMacro).arguments_).to.eql({});
      expect((result as InitializeMacro).template).to.be.instanceOf(
        ExpressionNode,
      );
    });

    it('should extract an initialization macro with arguments', () => {
      const result = Node.from({
        $init: '{@/templates/foo}',
        foo: 'bar',
        fizz: 'buzz',
      });

      expect(result).to.be.instanceOf(InitializeMacro);
      expect((result as InitializeMacro).arguments_)
        .property('foo')
        .to.be.instanceOf(StringNode);
      expect((result as InitializeMacro).arguments_)
        .property('fizz')
        .to.be.instanceOf(StringNode);
      expect((result as InitializeMacro).template).to.be.instanceOf(
        ExpressionNode,
      );
    });
  });
});
