import type { Content, EvaluationRequest, ImageAsset, Json, Question } from '../types';
import { identifier, record, text } from '../validation';

// The text that stands for the image tag in the JSON of the advanced image card.
const IMAGE_REFERENCE = '{{image}}';

export function validateRequest(input: unknown): EvaluationRequest {
    const body = record(input);
    onlyKeys(body, ['state', 'questions', 'assets']);
    const state = content(body.state, 'State');
    const entries = Object.entries(record(body.questions));
    if (entries.length < 1 || entries.length > 64) throw new Error('Provide 1–64 questions.');
    const questions = Object.fromEntries(entries.map(([id, value]) => {
        if (identifier(id) !== id) throw new Error('Question IDs cannot contain surrounding whitespace.');
        return [id, question(value)];
    }));
    const request = {state, questions};
    if (JSON.stringify(request).length > 64000) throw new Error('State and questions must fit within 64,000 characters.');
    const assets = body.assets === undefined ? undefined : Object.fromEntries(Object.entries(record(body.assets)).map(([reference, value]) => [reference, asset(value)]));
    if (!assets && Object.values(questions).some(item => item.type === 'box')) throw new Error('Box requires an image.');
    // The API rejects images that nothing refers to; object keys are never replaced by images.
    const values = strings(request);
    if (Object.keys(assets ?? {}).some(reference => !values.some(value => value.includes(reference)))) throw new Error(`Refer to the image as ${IMAGE_REFERENCE} in state, instructions or criteria.`);
    return assets ? {...request, assets} : request;
}

// Users never write assets themselves; the advanced image card supplies its image here.
export function parseRequest(input: unknown, image?: ImageAsset): EvaluationRequest {
    const source = text(input, 'Request JSON', 64000);
    let value: unknown;
    try { value = JSON.parse(source); }
    catch { throw new Error('Invalid JSON. Supply an object containing state and questions.'); }
    const body = record(value);
    onlyKeys(body, ['state', 'questions']);
    return validateRequest(image ? {...body, assets: {[IMAGE_REFERENCE]: image}} : body);
}

function asset(value: unknown): ImageAsset {
    const {format, data} = record(value);
    if (format !== 'jpg' || !(data instanceof Uint8Array)) throw new Error('Images must be prepared JPEG data.');
    return {format, data};
}

function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object') return [];
    return Object.values(value).flatMap(strings);
}

function question(input: unknown): Question {
    const value = record(input);
    onlyKeys(value, ['type', 'instructions', 'criteria']);
    const instructions = content(value.instructions, 'Instructions');
    if (value.type === 'noul') {
        if (value.criteria === undefined) return {type: 'noul', instructions};
        const criteria = record(value.criteria);
        onlyKeys(criteria, ['true', 'false']);
        return {type: 'noul', instructions, criteria: {true: content(criteria.true, 'Yes criteria'), false: content(criteria.false, 'No criteria')}};
    }
    if (value.type === 'choice') {
        const entries = Object.entries(record(value.criteria));
        if (entries.length < 2 || entries.length > 255) throw new Error('Choice requires 2–255 answers.');
        const criteria = Object.fromEntries(entries.map(([name, description]) => {
            if (text(name, 'Answer name', 200) !== name) throw new Error('Answer names cannot contain surrounding whitespace.');
            if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Invalid answer name.');
            return [name, description === null ? null : content(description, 'Answer description')];
        }));
        return {type: 'choice', instructions, criteria};
    }
    if (value.type === 'score') {
        if (!Array.isArray(value.criteria) || value.criteria.length < 2 || value.criteria.length > 10) throw new Error('Score requires 2–10 described levels.');
        return {type: 'score', instructions, criteria: value.criteria.map(level => content(level, 'Level description'))};
    }
    if (value.type === 'box') {
        if (value.criteria !== undefined) throw new Error('Box questions take no criteria.');
        return {type: 'box', instructions};
    }
    throw new Error('Question type must be choice, noul, score or box.');
}

function content(value: unknown, name: string): Content {
    if (typeof value === 'string') return text(value, name, 64000);
    if (!value || typeof value !== 'object') throw new Error(`${name} must be text, an object or an array.`);
    validateJson(value, 0);
    return value as Content;
}

function validateJson(value: unknown, depth: number): asserts value is Json {
    if (depth > 32) throw new Error('JSON is nested too deeply.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object') throw new Error('Invalid JSON value.');
    for (const item of Object.values(value)) validateJson(item, depth + 1);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
    if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Allowed fields: ${keys.join(', ')}.`);
}
