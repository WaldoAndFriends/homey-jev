import { action } from '@basmilius/homey-common';
import JevAction, { type ImageArgs, type Tokens } from '../jevAction';

/**
 * Action that finds where something is in an image tag, as a box with edges given
 * as fractions of the image's width and height.
 */
@action('image_locate')
export default class extends JevAction<ImageArgs, Result> {
    protected override readonly usesImage = true;

    async onRun(args: ImageArgs): Promise<Result> {
        // TypeSafe has no recommended Box threshold; 0.6 is the example from its docs.
        const minimum = this.threshold(args, 'Minimum confidence', 0, 0.6);
        const response = await this.ask(args, {type: 'box'});
        const answer = response.answers.answer;

        if (answer.type !== 'box') {
            throw new Error('Unexpected answer type.');
        }

        // A Box always has edges, even when the target is absent, so confidence is the only guard.
        if (answer.confidence < minimum) {
            throw new Error(`Jev is uncertain. Box confidence: ${answer.confidence}; required: at least ${minimum}.`);
        }

        return {
            ...this.tokens(response),
            ...answer.box,
            confidence: answer.confidence
        };
    }
}

type Result = Tokens & {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly confidence: number;
};
