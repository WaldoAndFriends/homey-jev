import { App } from '@basmilius/homey-common';
import Jev from './brain/jev';
import { DEFAULT_SETTINGS, SETTING_API_KEY, SETTING_CONFIG } from './const';
import { Actions } from './flow';
import type { EvaluationRequest, Settings } from './types';
import { record, text, validateSettings } from './validation';

export default class JevApp extends App<JevApp> {
    readonly #client = new Jev();

    async onInit(): Promise<void> {
        this.#registerActions();
        this.log('Jev initialized. State and questions are supplied by Flow cards.');
    }

    get config(): Settings {
        return validateSettings(this.homey.settings.get(SETTING_CONFIG) ?? DEFAULT_SETTINGS);
    }

    evaluate(request: EvaluationRequest) {
        return this.#client.evaluate(request, this.config, this.homey.settings.get(SETTING_API_KEY) ?? '');
    }

    getSettings() {
        return {...this.config, hasApiKey: !!this.homey.settings.get(SETTING_API_KEY)};
    }

    saveSettings(input: unknown) {
        const body = record(input);
        const config = validateSettings(body);
        const apiKey = body.apiKey === undefined ? '' : text(body.apiKey, 'API key', 512, true);

        if (apiKey && /\s/.test(apiKey)) {
            throw new Error('API key cannot contain whitespace.');
        }

        if (body.clearApiKey === true) {
            this.homey.settings.unset(SETTING_API_KEY);
        } else if (apiKey) {
            this.homey.settings.set(SETTING_API_KEY, apiKey);
        }

        this.homey.settings.set(SETTING_CONFIG, config);

        return this.getSettings();
    }

    async testConnection() {
        const response = await this.evaluate({
            state: 'Hello',
            questions: {
                greeting: {type: 'noul', instructions: 'Does the supplied text say hello?'}
            }
        });

        return {model: response.model, inputTokens: response.inputTokens};
    }

    #registerActions(): void {
        this.registry.action(Actions.Advanced);
        this.registry.action(Actions.ChoiceList);
        this.registry.action(Actions.ImageAdvanced);
        this.registry.action(Actions.ImageChoiceList);
        this.registry.action(Actions.ImageLocate);
        this.registry.action(Actions.ImageScore);
        this.registry.action(Actions.ImageYesNo);
        this.registry.action(Actions.Score);
        this.registry.action(Actions.YesNo);
    }
}
