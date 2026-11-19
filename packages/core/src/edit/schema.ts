// Zod schemas for the minimal-edit protocol (kept apart from patch.ts so browser
// content scripts can apply edits without bundling zod).

import { z } from 'zod';

export const EditBlockSchema = z.object({
  search: z.string().describe('Exact existing text to replace, copied verbatim from the file (include enough lines to be unique). Empty string only when inserting at the cursor.'),
  replace: z.string().describe('The new text.'),
});
export type EditBlock = z.infer<typeof EditBlockSchema>;

export const EditPlanSchema = z.object({
  summary: z.string().describe('One short sentence describing the change, for the UI.'),
  edits: z.array(EditBlockSchema),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;
