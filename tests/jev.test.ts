import { describe, expect, test } from 'bun:test';
import Jev, { parseResponse } from '../src/brain/jev';
import { parseRequest, validateRequest } from '../src/brain/request';
import { DEFAULT_SETTINGS } from '../src/const';
import type { EvaluationRequest } from '../src/types';

const request: EvaluationRequest = {
    state: {activity: 'film'}, questions: {
        scene: {type: 'choice', instructions: 'Which scene?', criteria: {film: 'Watching a film', bright: 'Reading'}},
        interrupt: {type: 'noul', instructions: 'Interrupt now?'},
        urgency: {type: 'score', instructions: 'How urgent?', criteria: ['Routine', 'Soon', 'Immediate']}
    }
};
const payload = {
    model: 'jev-1.13.0', usage: {input_tokens: 100, output_tokens: 20}, answers: {
        scene: {type: 'choice', choice: 'film', confidence: 0.9, probabilities: {film: 0.95, bright: 0.05}},
        interrupt: {type: 'noul', noul: 0.1},
        urgency: {type: 'score', score: 0.4, confidence: 0.7, probabilities: {'0': 0.6, '1': 0.4, '2': 0}, legend: {'0': 'Routine', '1': 'Soon', '2': 'Immediate'}}
    }
};

describe('request validation', () => {
    test('supports multiple questions, structured state and structured instructions', () => {
        expect(parseRequest(JSON.stringify(request))).toEqual(request);
        expect(validateRequest({state: ['a', 'b'], questions: {q: {type: 'noul', instructions: {question: 'Urgent?'}, criteria: {true: ['Now'], false: 'Later'}}}}).questions.q.type).toBe('noul');
    });

    test('rejects malformed JSON, unknown fields and unsupported question types', () => {
        for (const value of ['{bad', '{}', 'null', '[]', JSON.stringify({...request, apiKey: 'do not send'}), JSON.stringify({...request, model: 'override'}), JSON.stringify({state: 'a', questions: {q: {type: 'chat', instructions: 'Hi'}}})]) {
            expect(() => parseRequest(value)).toThrow();
        }
    });

    test('rejects missing state, empty questions and invalid criteria', () => {
        for (const value of [
            {questions: request.questions}, {state: '  ', questions: request.questions},
            {state: 'a', questions: {}}, {state: 42, questions: request.questions},
            {state: 'a', questions: {q: {type: 'score', instructions: 'Rate', criteria: ['One']}}},
            {state: 'a', questions: {q: {type: 'choice', instructions: 'Pick', criteria: {only: null}}}},
            {state: 'a', questions: {q: {type: 'noul', instructions: 'Yes?', criteria: {true: 'Yes'}}}}
        ]) expect(() => validateRequest(value)).toThrow();
    });

    test('limits payload size, nesting and question count before network access', () => {
        expect(() => parseRequest(' '.repeat(64001))).toThrow();
        expect(() => validateRequest({state: 'x'.repeat(63999), questions: request.questions})).toThrow();
        expect(() => validateRequest({state: 'a', questions: Object.fromEntries(Array.from({length: 65}, (_, i) => [`q${i}`, request.questions.interrupt]))})).toThrow();
        let state: unknown = 'a';
        for (let i = 0; i < 34; i++) state = [state];
        expect(() => validateRequest({state, questions: request.questions})).toThrow();
    });
});

describe('responses', () => {
    test('validates all question answers and preserves score rubric', () => {
        const result = parseResponse(payload, request);
        expect(result.answers).toEqual(payload.answers);
        expect(result.inputTokens).toBe(100);
        expect(result.outputTokens).toBe(20);
    });

    test('rejects incomplete answers and type mismatches', () => {
        expect(() => parseResponse({...payload, answers: {scene: payload.answers.scene}}, request)).toThrow();
        expect(() => parseResponse({...payload, answers: {...payload.answers, scene: payload.answers.interrupt}}, request)).toThrow();
        expect(() => parseResponse({...payload, answers: {...payload.answers, extra: payload.answers.interrupt}}, request)).toThrow();
    });

    test('rejects unknown choices, invalid distributions and contradictory winners', () => {
        for (const scene of [
            {...payload.answers.scene, choice: 'unknown'},
            {...payload.answers.scene, confidence: 2},
            {...payload.answers.scene, probabilities: {film: 0.1, bright: 0.9}},
            {...payload.answers.scene, probabilities: {film: 1}},
            {...payload.answers.scene, probabilities: {film: 0.9, bright: 0.9}}
        ]) expect(() => parseResponse({...payload, answers: {...payload.answers, scene}}, request)).toThrow();
    });

    test('rejects invalid Noul probabilities, scores and token usage', () => {
        expect(() => parseResponse({...payload, answers: {...payload.answers, interrupt: {type: 'noul', noul: -0.1}}}, request)).toThrow();
        expect(() => parseResponse({...payload, answers: {...payload.answers, urgency: {...payload.answers.urgency, score: 1.8}}}, request)).toThrow();
        expect(() => parseResponse({...payload, usage: {input_tokens: 1.5, output_tokens: 0}}, request)).toThrow();
    });
});

describe('client', () => {
    test('sends only user state/questions plus configured model in one call', async () => {
        let calls = 0;
        const client = new Jev(async (url, init) => {
            calls++;
            expect(url).toBe('https://api.typesafe.ai/v1/systemone');
            expect(JSON.parse(init.body as string)).toEqual({...request, model: DEFAULT_SETTINGS.model});
            expect(init.redirect).toBe('error');
            expect(init.signal).toBeDefined();
            return Response.json(payload);
        });
        const result = await client.evaluate(request, DEFAULT_SETTINGS, 'test-key');
        expect(calls).toBe(1);
        expect(result.requestId).toBeString();
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('validates before spending credit and requires a key', async () => {
        let calls = 0;
        const client = new Jev(async () => { calls++; return Response.json(payload); });
        await expect(client.evaluate({...request, questions: {}}, DEFAULT_SETTINGS, 'test')).rejects.toThrow();
        await expect(client.evaluate(request, DEFAULT_SETTINGS, '')).rejects.toThrow('API key');
        expect(calls).toBe(0);
    });

    test('does not forward provider bodies or transport details and never retries', async () => {
        let calls = 0;
        const client = new Jev(async () => { calls++; return new Response('PRIVATE STATE AND KEY', {status: 500}); });
        await expect(client.evaluate(request, DEFAULT_SETTINGS, 'test')).rejects.toThrow('HTTP 500');
        expect(calls).toBe(1);
        const failed = new Jev(async () => { throw new Error('PRIVATE KEY'); });
        await expect(failed.evaluate(request, DEFAULT_SETTINGS, 'test')).rejects.toThrow('could not be reached');
    });

    test('applies a shared request limit and recovers after the time window', async () => {
        let now = 100000;
        const client = new Jev(async () => Response.json(payload), () => now);
        const settings = {...DEFAULT_SETTINGS, maxCallsPerMinute: 1};
        await client.evaluate(request, settings, 'test');
        await expect(client.evaluate(request, settings, 'test')).rejects.toThrow('limit');
        now += 60001;
        expect((await client.evaluate(request, settings, 'test')).answers.scene).toEqual(payload.answers.scene);
    });

    test('limits concurrent requests and releases slots after completion', async () => {
        const releases: (() => void)[] = [];
        const client = new Jev(() => new Promise(resolve => { releases.push(() => resolve(Response.json(payload))); }));
        const pending = Array.from({length: 4}, () => client.evaluate(request, DEFAULT_SETTINGS, 'test'));
        await expect(client.evaluate(request, DEFAULT_SETTINGS, 'test')).rejects.toThrow('Four');
        releases.forEach(release => release());
        const results = await Promise.all(pending);
        expect(new Set(results.map(result => result.requestId)).size).toBe(4);
        const next = client.evaluate(request, DEFAULT_SETTINGS, 'test');
        releases.at(-1)!();
        await next;
    });
});

describe('images and boxes', () => {
    const image = {format: 'jpg' as const, data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9])};
    const imageRequest: EvaluationRequest = {
        state: {door: 'ref-door'},
        questions: {parcel: {type: 'box', instructions: 'the parcel in `door`'}},
        assets: {'ref-door': image}
    };
    const box = {model: 'jev-1.14.0', usage: {input_tokens: 900, output_tokens: 20}, answers: {
        parcel: {type: 'box', box: {top: 0.25, bottom: 0.82, left: 0.44, right: 0.84}, confidence: 0.92}
    }};

    test('sends images as base64 assets with the images header', async () => {
        const client = new Jev(async (_, init) => {
            expect((init.headers as Record<string, string>)['TypeSafe-Danger-Zone-Images']).toBe('true');
            expect(JSON.parse(init.body as string)).toEqual({
                model: DEFAULT_SETTINGS.model,
                state: imageRequest.state,
                questions: imageRequest.questions,
                assets: {'ref-door': {type: 'image', format: 'jpg', data_base64: '/9j/2Q=='}}
            });
            return Response.json(box);
        });
        const result = await client.evaluate(imageRequest, DEFAULT_SETTINGS, 'test');
        expect(result.answers.parcel).toEqual(box.answers.parcel);
    });

    test('omits the images header for text-only requests', async () => {
        const client = new Jev(async (_, init) => {
            expect((init.headers as Record<string, string>)['TypeSafe-Danger-Zone-Images']).toBeUndefined();
            return Response.json(payload);
        });
        await client.evaluate(request, DEFAULT_SETTINGS, 'test');
    });

    test('rejects boxes without images, unreferenced images and assets in user JSON', () => {
        expect(() => validateRequest({...imageRequest, assets: undefined})).toThrow('Box requires an image');
        expect(() => parseRequest(JSON.stringify({state: 'a', questions: imageRequest.questions}))).toThrow('Box requires an image');
        expect(() => validateRequest({...imageRequest, assets: {'other-ref': image}})).toThrow('Refer to the image');
        // Object keys are never replaced by images, so a reference used only as a key does not count.
        expect(() => validateRequest({...imageRequest, state: {'ref-door': 'photo'}})).toThrow('Refer to the image');
        expect(() => parseRequest(JSON.stringify({state: 'a', questions: request.questions, assets: {}}))).toThrow('Allowed fields');
        expect(() => validateRequest({...imageRequest, assets: {'ref-door': {format: 'gif', data: image.data}}})).toThrow('JPEG');
        expect(() => validateRequest({...imageRequest, questions: {q: {type: 'box', instructions: 'mug', criteria: ['x']}}})).toThrow('no criteria');
        expect(parseRequest(JSON.stringify({state: {door: '{{image}}'}, questions: imageRequest.questions}), image).assets).toEqual({'{{image}}': image});
    });

    test('rejects boxes outside the image or with crossed edges', () => {
        expect(parseResponse(box, imageRequest).answers.parcel).toEqual(box.answers.parcel);
        for (const edges of [{top: 0.25, bottom: 1.2, left: 0.44, right: 0.84}, {top: 0.25, bottom: 0.82, left: 0.9, right: 0.84}, {top: 0.25, bottom: 0.82, left: 0.44}]) {
            expect(() => parseResponse({...box, answers: {parcel: {...box.answers.parcel, box: edges}}}, imageRequest)).toThrow();
        }
        expect(() => parseResponse({...box, answers: {parcel: {...box.answers.parcel, confidence: 1.5}}}, imageRequest)).toThrow();
    });
});
