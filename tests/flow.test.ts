import { expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { encode } from 'jpeg-js';
import { Actions } from '../src/flow';
import type JevApp from '../src/index';
import type { EvaluationRequest, EvaluationResponse } from '../src/types';

class Card {
    run!: (args: any) => Promise<any>;

    registerRunListener(listener: Card['run']): this {
        this.run = listener;
        return this;
    }

    // The flow entities subscribe to `update` to refresh autocomplete providers.
    on(): this {
        return this;
    }
}

function fixture() {
    const cards = new Map<string, Card>();
    const requests: EvaluationRequest[] = [];
    let confidence = 0.95;
    let probability = 0.95;
    let choice = 'answer_2';

    function card(id: string): Card {
        if (!cards.has(id)) {
            cards.set(id, new Card());
        }

        return cards.get(id)!;
    }

    async function evaluate(request: EvaluationRequest): Promise<EvaluationResponse> {
        requests.push(request);
        const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id,
            question.type === 'choice' ? {type: 'choice', choice, confidence, probabilities: {[choice]: 0.95}}
                : question.type === 'noul' ? {type: 'noul', noul: probability}
                : question.type === 'box' ? {type: 'box', box: {top: 0.1, bottom: 0.6, left: 0.2, right: 0.5}, confidence}
                : {type: 'score', score: 1.5, confidence, probabilities: {'0': 0, '1': 0.5, '2': 0.5}, legend: {'0': 'low', '1': 'mid', '2': 'high'}}
        ]));
        return {answers, model: 'jev-latest', inputTokens: 20, outputTokens: 5, requestId: `request-${requests.length}`, durationMs: 10} as EvaluationResponse;
    }

    const app = {
        evaluate,
        homey: {
            flow: {
                getActionCard: (id: string) => card(`action:${id}`),
                getConditionCard: (id: string) => card(`condition:${id}`),
                getTriggerCard: (id: string) => card(`trigger:${id}`),
                getDeviceTriggerCard: (id: string) => card(`device-trigger:${id}`)
            },
            log: () => {
            }
        }
    } as unknown as JevApp;

    for (const Action of Object.values(Actions)) {
        new Action(app);
    }

    return {cards, card, requests, setChoice: (value: string) => { choice = value; }, setConfidence: (value: number) => { confidence = value; }, setProbability: (value: number) => { probability = value; }};
}

const base = {state: 'We are watching a film.', question: 'Which light scene fits?'};

const photo = encode({width: 640, height: 480, data: Buffer.alloc(640 * 480 * 4, 128)}, 90).data;
const droptoken = {getStream: async () => Readable.from([photo])};

test('registers only action cards, without conditions or triggers', () => {
    const f = fixture();
    expect([...f.cards.keys()].sort()).toEqual([
        'action:advanced', 'action:choice_list', 'action:image_advanced', 'action:image_choice_list',
        'action:image_locate', 'action:image_score', 'action:image_yes_no', 'action:score', 'action:yes_no'
    ]);
});

for (const count of [2, 3, 4]) {
    test(`choice with ${count} answers sends exactly one question and returns text and position`, async () => {
        const f = fixture();
        const args = {...base, answers: ['Bright', 'Film', 'Cozy', 'No change'].slice(0, count).join('\n')};
        const result = await f.card('action:choice_list').run(args);
        expect(result.answer).toBe('Film');
        expect(result.answer_number).toBe(2);
        expect(result.confidence).toBe(0.95);
        expect(Object.keys(f.requests[0].questions)).toEqual(['answer']);
        expect(Object.keys(f.requests[0].questions.answer.criteria!)).toHaveLength(count);
        expect(f.requests[0].state).toBe(base.state);
    });
}

test('yes/no action distinguishes yes, no and uncertainty', async () => {
    const f = fixture();
    expect((await f.card('action:yes_no').run(base)).answer).toBe(true);
    f.setProbability(0.2);
    expect((await f.card('action:yes_no').run(base)).answer).toBe(false);
    f.setProbability(0.5);
    await expect(f.card('action:yes_no').run(base)).rejects.toThrow('uncertain');
    f.setProbability(0.8);
    expect((await f.card('action:yes_no').run(base)).answer).toBe(true);
});

test('score sends one described rubric and returns a fractional score', async () => {
    const f = fixture();
    const args = {...base, low: 'No interruption', middle: 'Some interruption', high: 'Major interruption'};
    const result = await f.card('action:score').run(args);
    expect(result.score).toBe(1.5);
    expect(f.requests[0].questions.answer.criteria).toEqual([args.low, args.middle, args.high]);
    f.setConfidence(0.3);
    await expect(f.card('action:score').run(args)).rejects.toThrow('uncertain');
});

test('advanced returns multiple raw answers, including uncertainty, without global state', async () => {
    const f = fixture();
    f.setProbability(0.5);
    const request = {state: {room: 'Living room'}, questions: {a: {type: 'noul', instructions: 'Notify?'}, b: {type: 'noul', instructions: 'Dim?'}}};
    const result = await f.card('action:advanced').run({json: JSON.stringify(request)});
    expect(f.requests).toEqual([request]);
    expect(JSON.parse(result.answers)).toEqual({a: {type: 'noul', noul: 0.5}, b: {type: 'noul', noul: 0.5}});
    expect(result.request_id).toBe('request-1');
    const next = await f.card('action:yes_no').run({...base, minimum: 0.9}).catch(() => null);
    expect(next).toBeNull();
    expect(JSON.parse(result.answers).a.noul).toBe(0.5);
});

test('rejects invalid thresholds and advanced JSON before the API call', async () => {
    const f = fixture();
    await expect(f.card('action:yes_no').run({...base, minimum: 0.5})).rejects.toThrow();
    await expect(f.card('action:choice_list').run({...base, answers: 'Bright\nFilm', minimum: 2})).rejects.toThrow();
    await expect(f.card('action:advanced').run({json: '{bad'})).rejects.toThrow('Invalid JSON');
    expect(f.requests).toHaveLength(0);
});


test('uncertainty reports the received probability and both acceptance boundaries', async () => {
    const f = fixture();
    f.setProbability(0.61);
    const args = {state: 'Bas=true Fleur=no', question: 'Is Bas sleeping?', minimum: 0.8};
    await expect(f.card('action:yes_no').run(args)).rejects.toThrow('Probability of yes: 0.61; yes requires at least 0.8, no requires at most 0.2.');
    expect(f.requests[0]).toEqual({state: args.state, questions: {answer: {type: 'noul', instructions: args.question}}});
    f.setProbability(0.200000001);
    await expect(f.card('action:yes_no').run(args)).rejects.toThrow('Probability of yes: 0.200000001');
});

test('list trims lines, ignores blanks and preserves order and punctuation', async () => {
    const f = fixture();
    f.setChoice('answer_5');
    const result = await f.card('action:choice_list').run({...base, answers: '\r\n Bright \r\n Film, cozy \r\n\r\n Reading / work \rCleaning\n No change \n'});
    expect(f.requests).toEqual([{state: base.state, questions: {answer: {
        type: 'choice', instructions: base.question,
        criteria: {answer_1: 'Bright', answer_2: 'Film, cozy', answer_3: 'Reading / work', answer_4: 'Cleaning', answer_5: 'No change'}
    }}}]);
    expect(result).toMatchObject({answer: 'No change', answer_number: 5, confidence: 0.95, probability: 0.95});
});

test('list rejects invalid input before evaluating', async () => {
    const f = fixture();
    for (const answers of [
        undefined, 42, '', '   \n ', 'Only one', ' Film \nfilm',
        Array.from({length: 256}, (_, i) => `Option ${i}`).join('\n'),
        'a'.repeat(2001) + '\nOther',
        'a'.repeat(64001)
    ]) {
        await expect(f.card('action:choice_list').run({...base, answers})).rejects.toThrow();
    }
    await expect(f.card('action:choice_list').run({...base, answers: 'One\nTwo', minimum: 2})).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
});

test('list supports 255 answers and returns the last answer by position', async () => {
    const f = fixture();
    f.setChoice('answer_255');
    const answers = Array.from({length: 255}, (_, i) => `Option ${i + 1}`).join('\n');
    const result = await f.card('action:choice_list').run({...base, answers});
    expect(Object.keys(f.requests[0].questions.answer.criteria!)).toHaveLength(255);
    expect(result.answer).toBe('Option 255');
    expect(result.answer_number).toBe(255);
});

test('list applies default and custom confidence thresholds', async () => {
    const f = fixture();
    f.setConfidence(0.6);
    const args = {...base, answers: 'Bright\nFilm'};
    await expect(f.card('action:choice_list').run(args)).rejects.toThrow('uncertain');
    expect((await f.card('action:choice_list').run({...args, minimum: 0.6})).answer).toBe('Film');
});

test('score rejects missing and duplicate levels before evaluating', async () => {
    const f = fixture();
    await expect(f.card('action:score').run({...base, low: 'Dark', middle: ' dark ', high: 'Bright'})).rejects.toThrow('different');
    await expect(f.card('action:score').run({...base, low: 'Dark', middle: 'Comfortable'})).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
});

test('image cards send the image as an asset referenced from the state, with optional context', async () => {
    const f = fixture();
    const result = await f.card('action:image_yes_no').run({droptoken, question: 'Is there a parcel at the door?'});
    expect(result.answer).toBe(true);
    const [request] = f.requests;
    const reference = (request.state as {image: string}).image;
    expect(request.state).toEqual({image: reference});
    expect(request.questions).toEqual({answer: {type: 'noul', instructions: 'Is there a parcel at the door?'}});
    expect(Object.keys(request.assets!)).toEqual([reference]);
    expect(request.assets![reference].format).toBe('jpg');

    await f.card('action:image_yes_no').run({droptoken, state: ' Front door camera ', question: 'Parcel?'});
    const second = f.requests[1].state as {image: string; context: string};
    expect(second.context).toBe('Front door camera');
    expect(second.image).not.toBe(reference);
});

test('image choice and score cards reuse the list and rubric rules', async () => {
    const f = fixture();
    const choice = await f.card('action:image_choice_list').run({droptoken, question: 'Who is at the door?', answers: 'Courier\nNeighbour\nNobody'});
    expect(choice.answer).toBe('Neighbour');
    expect(f.requests[0].questions.answer.criteria).toEqual({answer_1: 'Courier', answer_2: 'Neighbour', answer_3: 'Nobody'});
    const score = await f.card('action:image_score').run({droptoken, question: 'How tidy?', low: 'Messy', middle: 'Okay', high: 'Tidy'});
    expect(score.score).toBe(1.5);
    await expect(f.card('action:image_choice_list').run({droptoken, question: 'Who?', answers: 'Only one'})).rejects.toThrow();
    expect(f.requests).toHaveLength(2);
});

test('locate returns the box edges and applies its confidence threshold', async () => {
    const f = fixture();
    const result = await f.card('action:image_locate').run({droptoken, question: 'the parcel on the doormat'});
    expect(result).toMatchObject({top: 0.1, bottom: 0.6, left: 0.2, right: 0.5, confidence: 0.95});
    expect(f.requests[0].questions).toEqual({answer: {type: 'box', instructions: 'the parcel on the doormat'}});
    f.setConfidence(0.5);
    await expect(f.card('action:image_locate').run({droptoken, question: 'the parcel'})).rejects.toThrow('uncertain');
    expect((await f.card('action:image_locate').run({droptoken, question: 'the parcel', minimum: 0.4})).confidence).toBe(0.5);
});

test('advanced image card replaces {{image}} with the image tag and supports boxes', async () => {
    const f = fixture();
    const json = JSON.stringify({state: {door: '{{image}}'}, questions: {
        visible: {type: 'noul', instructions: 'Is there a parcel in `door`?'},
        parcel: {type: 'box', instructions: 'the parcel in `door`'}
    }});
    const result = await f.card('action:image_advanced').run({droptoken, json});
    expect(Object.keys(JSON.parse(result.answers))).toEqual(['visible', 'parcel']);
    expect(Object.keys(f.requests[0].assets!)).toEqual(['{{image}}']);
});

test('image cards reject missing images and invalid requests before calling the API', async () => {
    const f = fixture();
    await expect(f.card('action:image_yes_no').run({question: 'Parcel?'})).rejects.toThrow('image tag');
    await expect(f.card('action:image_advanced').run({droptoken, json: JSON.stringify({state: 'door', questions: {q: {type: 'noul', instructions: 'Parcel?'}}})})).rejects.toThrow('{{image}}');
    await expect(f.card('action:image_advanced').run({droptoken, json: '{bad'})).rejects.toThrow('Invalid JSON');
    await expect(f.card('action:image_yes_no').run({droptoken: {getStream: async () => Readable.from([Buffer.from('not an image')])}, question: 'Parcel?'})).rejects.toThrow('PNG or JPEG');
    await expect(f.card('action:image_yes_no').run({droptoken: {getStream: async () => { throw new Error('PRIVATE URL'); }}, question: 'Parcel?'})).rejects.toThrow('could not be read');
    expect(f.requests).toHaveLength(0);
});

test('text cards still reject box questions, which need an image', async () => {
    const f = fixture();
    const json = JSON.stringify({state: 'a', questions: {q: {type: 'box', instructions: 'the mug'}}});
    await expect(f.card('action:advanced').run({json})).rejects.toThrow('Box requires an image');
});
