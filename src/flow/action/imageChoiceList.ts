import { action } from '@basmilius/homey-common';
import type { ImageArgs } from '../jevAction';
import { type ChoiceListArgs, ChoiceListAction } from './choiceList';

/**
 * Action that picks the answer that fits an image tag best, out of a list of
 * answers separated by newlines.
 */
@action('image_choice_list')
export default class extends ChoiceListAction<ImageArgs & ChoiceListArgs> {
    protected override readonly usesImage = true;
}
