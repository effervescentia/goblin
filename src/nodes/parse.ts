import { BooleanNode } from './boolean';
import { DieNode } from './die';
import { ExpressionNode } from './expression';
import { ListNode } from './list';
import type { Node } from './node';
import { NullNode } from './null';
import { NumberNode } from './number';
import { RecordNode } from './record';
import { StringNode } from './string';
import { UnexpectedNode } from './unexpected';

/** Classify a raw document value into its node kind. */
export function parse(raw: unknown): Node {
  const die = DieNode.match(raw);
  if (die) return die;
  if (raw === null || raw === undefined) return new NullNode(raw);
  if (typeof raw === 'boolean') return new BooleanNode(raw);
  if (typeof raw === 'number') return new NumberNode(raw);
  if (typeof raw === 'string') {
    if (ExpressionNode.matches(raw)) return new ExpressionNode(raw);
    return new StringNode(raw);
  }
  if (Array.isArray(raw)) return new ListNode(raw);
  if (typeof raw === 'object') return new RecordNode(raw as Record<string, unknown>);
  return new UnexpectedNode(raw);
}
