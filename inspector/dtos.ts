import z from 'zod';

export const ResolveRequestSchema = z.object({
  entry: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  overrides: z.record(z.string(), z.unknown()).default({}),
});
