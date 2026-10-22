import z from 'zod';
import { InputSchema } from '@/dtos';
import { INVOKE_ALONE } from './constants';

export const ServerModeSchema = z.enum(['stdio', 'http', 'websocket']);

export type ServerMode = z.infer<typeof ServerModeSchema>;

export const ConfigSchema = z.object({ root: z.string().default('.'), main: z.string() });

/**
 * Holds inputs to the rules `parseArgs` does; parsed inputs come out as { type, path, value }, extra keys dropped.
 */
export const ResolveParamsSchema = z.object({
  entry: z.string().optional(),
  in: z.unknown().optional(),
  inputs: z
    .array(InputSchema)
    .default([])
    .check((ctx) => {
      const invokes = ctx.value.filter((input) => input.type === 'invoke').length;
      if (invokes > 1)
        ctx.issues.push({ code: 'custom', input: ctx.value, message: 'inputs may hold one invoke per call' });
      else if (invokes > 0 && ctx.value.length > 1)
        ctx.issues.push({ code: 'custom', input: ctx.value, message: INVOKE_ALONE });
    }),
  stripMetadata: z.boolean().default(false),
});

export const RewindParamsSchema = z.object({ version: z.int().min(1) });

/** A state to inspect: a stateless server's `in`, else the session head for `entry`. */
export const InspectParamsSchema = z.object({ entry: z.string().optional(), in: z.unknown().optional() });

/** An actor to export: from a stateless server's `in`, else the session head for `entry`. */
export const ExportParamsSchema = InspectParamsSchema.extend({ actor: z.string().min(1) });

/** An `--export` output to import into the actor at `path`, as one turn. */
export const ImportParamsSchema = InspectParamsSchema.extend({ path: z.string().min(1), export: z.unknown() });
