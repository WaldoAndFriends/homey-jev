import { action } from '@basmilius/homey-common';
import { parseRequest } from '../../brain/request';
import JevAction, { type ImageArgs, type Tokens } from '../jevAction';

/**
 * Action that passes a hand-written request through together with an image tag,
 * so a flow can ask several questions, including Box questions, about one image.
 */
@action('image_advanced')
export default class extends JevAction<Args, Result> {
    async onRun(args: Args): Promise<Result> {
        const response = await this.app.evaluate(parseRequest(args.json, await this.image(args)));

        return {
            ...this.tokens(response),
            answers: JSON.stringify(response.answers)
        };
    }
}

type Args = Pick<ImageArgs, 'droptoken'> & {
    readonly json: string;
};

type Result = Tokens & {
    readonly answers: string;
};
