import { z } from 'zod';

export interface ITool<TInput = unknown, TOutput = unknown> {
    readonly name: string;
    readonly description: string;
    readonly schema: z.ZodType<TInput>;

    execute(input: TInput): Promise<TOutput>;
}
