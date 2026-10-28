import { action } from '@basmilius/homey-common';
import type { ImageArgs } from '../jevAction';
import { YesNoAction } from './yesNo';

/**
 * Action that answers a yes/no question about an image tag.
 */
@action('image_yes_no')
export default class extends YesNoAction<ImageArgs> {
    protected override readonly usesImage = true;
}
