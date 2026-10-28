import { action } from '@basmilius/homey-common';
import type { ImageArgs } from '../jevAction';
import { type ScoreArgs, ScoreAction } from './score';

/**
 * Action that scores an image tag against three described levels.
 */
@action('image_score')
export default class extends ScoreAction<ImageArgs & ScoreArgs> {
    protected override readonly usesImage = true;
}
