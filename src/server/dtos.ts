import z from 'zod';

/**
 * A present `id` must be a string, number or null; an absent one makes the request a notification.
 */
export const RequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  id: z.union([z.string(), z.number(), z.null()]).exactOptional(),
  params: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.null()]).optional(),
});

export const FormatSchema = z.enum(['cbor', 'json']);

export type Format = z.infer<typeof FormatSchema>;
