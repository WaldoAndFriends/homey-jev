import { action } from '@basmilius/homey-common';
import JevAction, { type ImageArgs, type SimpleArgs, type Tokens } from '../jevAction';
import { text } from '../../validation';

/**
 * Scores the state or an image against three described levels and returns a value
 * that may fall between them.
 */
export abstract class ScoreAction<TArgs extends (SimpleArgs | ImageArgs) & ScoreArgs> extends JevAction<TArgs, Result> {
    async onRun(args: TArgs): Promise<Result> {
        const minimum = this.threshold(args, 'Minimum confidence');
        const criteria = [args.low, args.middle, args.high]
            .map(level => text(level, 'Level description', 2000));

        if (new Set(criteria.map(level => level.toLowerCase())).size !== criteria.length) {
            throw new Error('Describe three different score levels.');
        }

        const response = await this.ask(args, {type: 'score', criteria});
        const answer = response.answers.answer;

        if (answer.type !== 'score') {
            throw new Error('Unexpected answer type.');
        }

        if (answer.confidence < minimum) {
            throw new Error(`Jev is uncertain. Score confidence: ${answer.confidence}; required: at least ${minimum}.`);
        }

        return {
            ...this.tokens(response),
            score: answer.score,
            confidence: answer.confidence
        };
    }
}

/**
 * Action that scores the state against three described levels and returns a
 * value that may fall between them.
 */
@action('score')
export default class extends ScoreAction<SimpleArgs & ScoreArgs> {}

export type ScoreArgs = {
    readonly low: string;
    readonly middle: string;
    readonly high: string;
};

type Result = Tokens & {
    readonly score: number;
    readonly confidence: number;
};
