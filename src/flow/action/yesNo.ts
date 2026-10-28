import { action } from '@basmilius/homey-common';
import JevAction, { type ImageArgs, type SimpleArgs, type Tokens } from '../jevAction';

/**
 * Answers a yes/no question about the state or an image.
 */
export abstract class YesNoAction<TArgs extends SimpleArgs | ImageArgs> extends JevAction<TArgs, Result> {
    async onRun(args: TArgs): Promise<Result> {
        const minimum = this.threshold(args, 'Minimum probability', 0.51);
        const response = await this.ask(args, {type: 'noul'});
        const answer = response.answers.answer;

        if (answer.type !== 'noul') {
            throw new Error('Unexpected answer type.');
        }

        const isYes = answer.noul >= minimum;
        // Rounded because 1 - 0.8 lands on 0.19999999999999996.
        const maximumNo = Number((1 - minimum).toFixed(12));

        if (!isYes && answer.noul > maximumNo) {
            throw new Error(`Jev is uncertain. Probability of yes: ${answer.noul}; yes requires at least ${minimum}, no requires at most ${maximumNo}.`);
        }

        return {
            ...this.tokens(response),
            answer: isYes,
            probability: answer.noul
        };
    }
}

/**
 * Action that answers a yes/no question about the state.
 */
@action('yes_no')
export default class extends YesNoAction<SimpleArgs> {}

type Result = Tokens & {
    readonly answer: boolean;
    readonly probability: number;
};
