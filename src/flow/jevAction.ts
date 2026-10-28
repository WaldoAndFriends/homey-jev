import { randomUUID } from 'node:crypto';
import { FlowActionEntity } from '@basmilius/homey-common';
import type Homey from 'homey';
import { prepareImage, readImage } from '../brain/image';
import type JevApp from '../index';
import type { Content, EvaluationResponse, ImageAsset, Question } from '../types';
import { number, text } from '../validation';

/**
 * Base class for the Jev action cards. Every card asks a single question about
 * a piece of state or an image and reports what the call cost.
 */
export default abstract class JevAction<TArgs, TResult> extends FlowActionEntity<JevApp, TArgs, never, TResult> {
    /** Whether the card asks about an image tag, with its text as optional context. */
    protected readonly usesImage: boolean = false;

    /**
     * Asks Jev one question about the state in the given arguments.
     *
     * @param args - The card arguments holding the state and the question.
     * @param body - The question to ask, without its instructions.
     */
    protected async ask(args: SimpleArgs | ImageArgs, body: QuestionBody): Promise<EvaluationResponse> {
        const instructions = text(args.question, 'Question', 8000);
        const question = {...body, instructions} as Question;

        if (!this.usesImage) {
            return await this.app.evaluate({
                state: text(args.state, 'State', 64000),
                questions: {answer: question}
            });
        }

        // Image cards treat the text as optional context next to the image. A fresh reference
        // cannot collide with the user's own text, which the API would otherwise replace.
        const context = text(args.state ?? '', 'Context', 64000, true);
        const image = await this.image(args as ImageArgs);
        const reference = randomUUID();

        return await this.app.evaluate({
            state: context ? {image: reference, context} : {image: reference},
            questions: {answer: question},
            assets: {[reference]: image}
        });
    }

    /**
     * Reads the image tag dropped on the card and prepares it for TypeSafe.
     *
     * @param args - The card arguments holding the image tag.
     */
    protected async image(args: {readonly droptoken?: Homey.Image}): Promise<ImageAsset> {
        const image = args.droptoken;

        if (!image || typeof image.getStream !== 'function') {
            throw new Error('Drop an image tag on the card.');
        }

        let stream: NodeJS.ReadableStream;

        try {
            stream = await image.getStream();
        } catch {
            throw new Error('The image tag could not be read.');
        }

        return await prepareImage(await readImage(stream as AsyncIterable<Uint8Array>));
    }

    /**
     * Reads the confidence threshold from the arguments.
     *
     * @param args - The card arguments.
     * @param name - The label to use when the value is out of range.
     * @param min - The lowest threshold the card accepts.
     * @param fallback - The threshold when the card leaves it empty.
     */
    protected threshold(args: {readonly minimum?: number}, name: string, min = 0, fallback = 0.8): number {
        return number(args.minimum ?? fallback, name, min, 1);
    }

    /**
     * Maps the usage numbers of a response onto the flow tokens every card returns.
     */
    protected tokens(response: EvaluationResponse): Tokens {
        return {
            model: response.model,
            input_tokens: response.inputTokens,
            output_tokens: response.outputTokens,
            request_id: response.requestId,
            duration_ms: response.durationMs
        };
    }
}

/** The arguments shared by every card that asks a single question. */
export type SimpleArgs = {
    readonly state: string;
    readonly question: string;
    readonly minimum?: number;
};

/** The arguments of a card that asks a single question about an image tag. */
export type ImageArgs = {
    readonly droptoken: Homey.Image;
    /** Optional context next to the image. */
    readonly state?: string;
    readonly question: string;
    readonly minimum?: number;
};

/** A question without the instructions, which {@link JevAction.ask} validates and fills in. */
export type QuestionBody =
    | {readonly type: 'noul'}
    | {readonly type: 'choice'; readonly criteria: Record<string, Content | null>}
    | {readonly type: 'score'; readonly criteria: Content[]}
    | {readonly type: 'box'};

/** The flow tokens every card returns alongside its answer. */
export type Tokens = {
    readonly model: string;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly request_id: string;
    readonly duration_ms: number;
};
