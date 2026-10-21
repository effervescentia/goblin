import z from 'zod';
import { parseDice } from './inputs';

export const VersionSchema = z.int().nonnegative();

/** An input as given, before its run stamps a `version`. */
export const InputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['parameter', 'override']), path: z.string().min(1), value: z.unknown() }),
  z.object({ type: z.literal('invoke'), path: z.string().min(1), value: z.array(z.unknown()) }),
]);

const versioned = z.object({ version: VersionSchema });

const InputEventSchema = versioned.and(InputSchema);

const WriteEventSchema = versioned.extend({
  type: z.enum(['set', 'add', 'subtract']),
  path: z.string(),
  value: z.unknown(),
  rolled: z.boolean().optional(),
});

const RollEventSchema = versioned
  .extend({ type: z.literal('roll'), path: z.string(), dice: z.string(), value: z.array(z.int().min(1)) })
  .refine(({ dice, value }) => {
    const [count, sides] = parseDice(dice) ?? [];
    return sides !== undefined && value.length === count && value.every((face) => face <= sides);
  });

export const StateEventSchema = z.union([InputEventSchema, WriteEventSchema, RollEventSchema]);
