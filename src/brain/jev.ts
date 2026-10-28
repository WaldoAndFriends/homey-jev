import { randomUUID } from 'node:crypto';
import { API_URL } from '../const';
import type { Answer, EvaluationRequest, EvaluationResponse, Json, Question, Settings } from '../types';
import { number, record, text } from '../validation';
import { validateRequest } from './request';

export type Transport = (url: string, init: RequestInit) => Promise<globalThis.Response>;

export default class Jev {
    #calls: number[] = [];
    #pending = 0;

    constructor(private readonly transport: Transport = fetch, private readonly now: () => number = Date.now) {}

    async evaluate(input: EvaluationRequest, settings: Settings, apiKey: string): Promise<EvaluationResponse> {
        const request = validateRequest(input);
        if (!apiKey) throw new Error('Set your TypeSafe API key in the app settings.');
        const startedAt = this.now();
        this.#calls = this.#calls.filter(at => startedAt - at < 60000);
        if (this.#calls.length >= settings.maxCallsPerMinute) throw new Error('App request limit reached. Try again in a minute.');
        if (this.#pending >= 4) throw new Error('Four evaluations are already running. Try again shortly.');
        this.#calls.push(startedAt);
        this.#pending++;
        try {
            const result = await this.#request(request, settings, apiKey);
            return {...result, requestId: randomUUID(), durationMs: this.now() - startedAt};
        } finally {
            this.#pending--;
        }
    }

    async #request(request: EvaluationRequest, settings: Settings, apiKey: string): Promise<Omit<EvaluationResponse, 'requestId' | 'durationMs'>> {
        let response: globalThis.Response;
        try {
            response = await this.transport(API_URL, {
                method: 'POST',
                headers: requestHeaders(request, apiKey),
                body: requestBody(request, settings),
                signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
                redirect: 'error'
            });
        } catch {
            throw new Error('TypeSafe could not be reached or the request timed out.');
        }

        // Provider error bodies can echo state or credentials; never forward them to logs or Flows.
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) throw new Error('TypeSafe rejected the API key or account access.');
            if (response.status === 429) throw new Error('TypeSafe rate limit reached. Try again later.');
            if (response.status === 402) throw new Error('TypeSafe requires available credit.');
            throw new Error(`TypeSafe request failed (HTTP ${response.status}).`);
        }

        try { return parseResponse(await response.json(), request); }
        catch { throw new Error('TypeSafe returned an invalid decision response.'); }
    }
}

// Images are a preview feature that each request must opt into. Box questions always come with an image.
function requestHeaders(request: EvaluationRequest, apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json'};
    if (request.assets) headers['TypeSafe-Danger-Zone-Images'] = 'true';
    return headers;
}

function requestBody({state, questions, assets}: EvaluationRequest, settings: Settings): string {
    const encoded = assets && Object.fromEntries(Object.entries(assets).map(([reference, {format, data}]) => [reference, {
        type: 'image',
        format,
        data_base64: Buffer.from(data.buffer, data.byteOffset, data.length).toString('base64')
    }]));
    return JSON.stringify({model: settings.model, state, questions, assets: encoded});
}

export function parseResponse(input: unknown, request: EvaluationRequest): Omit<EvaluationResponse, 'requestId' | 'durationMs'> {
    const body = record(input);
    const rawAnswers = record(body.answers);
    if (Object.keys(rawAnswers).length !== Object.keys(request.questions).length) throw new Error('Incorrect number of answers.');
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, parseAnswer(rawAnswers[id], question)]));
    const usage = record(body.usage);
    const inputTokens = number(usage.input_tokens, 'Input tokens', 0, Number.MAX_SAFE_INTEGER);
    const outputTokens = number(usage.output_tokens, 'Output tokens', 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) throw new Error('Invalid token usage.');
    return {answers, model: text(body.model, 'Model', 100), inputTokens, outputTokens};
}

function parseAnswer(input: unknown, question: Question): Answer {
    const answer = record(input);
    if (answer.type !== question.type) throw new Error('Unexpected answer type.');
    if (question.type === 'noul') return {type: 'noul', noul: number(answer.noul, 'Probability', 0, 1)};
    if (question.type === 'box') {
        const box = record(answer.box);
        const [top, bottom, left, right] = ['top', 'bottom', 'left', 'right'].map(edge => number(box[edge], 'Box edge', 0, 1));
        if (left > right || top > bottom) throw new Error('Invalid box.');
        return {type: 'box', box: {top, bottom, left, right}, confidence: number(answer.confidence, 'Confidence', 0, 1)};
    }
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const rawProbabilities = record(answer.probabilities);
    if (Object.keys(rawProbabilities).length !== keys.length) throw new Error('Incomplete probabilities.');
    const probabilities = Object.fromEntries(keys.map(key => [key, number(rawProbabilities[key], 'Probability', 0, 1)]));
    if (Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.01) throw new Error('Invalid probability distribution.');
    const confidence = number(answer.confidence, 'Confidence', 0, 1);
    if (question.type === 'choice') {
        const choice = text(answer.choice, 'Choice', 200);
        if (!keys.includes(choice)) throw new Error('Unknown answer.');
        if (Object.values(probabilities).some(value => value > probabilities[choice] + 0.00001)) throw new Error('Choice does not match probabilities.');
        return {type: 'choice', choice, confidence, probabilities};
    }
    const score = number(answer.score, 'Score', 0, keys.length - 1);
    const expected = keys.reduce((sum, key) => sum + Number(key) * probabilities[key], 0);
    if (Math.abs(score - expected) > 0.02) throw new Error('Score does not match probabilities.');
    // Build the legend from the supplied rubric, rather than trusting additional provider content.
    const legend: Record<string, Json> = Object.fromEntries(question.criteria.map((level, index) => [String(index), level]));
    return {type: 'score', score, confidence, probabilities, legend};
}
