import { expect, test } from 'bun:test';
import { decode, encode } from 'jpeg-js';
import { PNG } from 'pngjs';
import { prepareImage, readImage } from '../src/brain/image';

type Color = [number, number, number, number];

function pixels(width: number, height: number, color: (x: number, y: number) => Color): Buffer {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
    }
    return data;
}

function jpeg(width: number, height: number, color: (x: number, y: number) => Color = () => [90, 120, 150, 255]): Buffer {
    return encode({width, height, data: pixels(width, height, color)}, 90).data;
}

function png(width: number, height: number, color: (x: number, y: number) => Color): Buffer {
    const image = new PNG({width, height});
    image.data = pixels(width, height, color);
    return PNG.sync.write(image);
}

/** Inserts an EXIF block with only an orientation tag directly after the JPEG start marker. */
function withOrientation(file: Buffer, orientation: number): Buffer {
    const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const header = Buffer.from([0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([file.subarray(0, 2), header, payload, file.subarray(2)]);
}

function pixel(file: Uint8Array, x: number, y: number): number[] {
    const image = decode(file, {useTArray: true, formatAsRGBA: true});
    return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
}

test('keeps images within the limits at their size', async () => {
    const scaled = decode((await prepareImage(jpeg(800, 600))).data, {useTArray: true});
    expect([scaled.width, scaled.height]).toEqual([800, 600]);
});

test('scales large images to a long side of 1568 pixels', async () => {
    const result = await prepareImage(jpeg(1920, 1080));
    const scaled = decode(result.data, {useTArray: true});
    expect(result.format).toBe('jpg');
    expect([scaled.width, scaled.height]).toEqual([1568, 882]);
    expect(pixel(result.data, 700, 400).every((value, index) => Math.abs(value - [90, 120, 150][index]) < 6)).toBe(true);
});

test('scales small images up to a short side of 280 pixels', async () => {
    const scaled = decode((await prepareImage(jpeg(200, 300))).data, {useTArray: true});
    expect([scaled.width, scaled.height]).toEqual([280, 420]);
});

test('rotates the pixels upright according to the EXIF orientation', async () => {
    // Left half red, right half blue; orientation 6 means the camera was turned clockwise.
    const file = withOrientation(jpeg(400, 300, x => x < 200 ? [255, 0, 0, 255] : [0, 0, 255, 255]), 6);
    const result = await prepareImage(file);
    const upright = decode(result.data, {useTArray: true});
    expect([upright.width, upright.height]).toEqual([300, 400]);
    expect(pixel(result.data, 150, 50)[0]).toBeGreaterThan(200);
    expect(pixel(result.data, 150, 350)[2]).toBeGreaterThan(200);
});

test('places transparent pixels on white when re-encoding as JPEG', async () => {
    const result = await prepareImage(png(1600, 1600, () => [0, 0, 0, 0]));
    expect(result.format).toBe('jpg');
    expect(pixel(result.data, 800, 800).every(value => value > 245)).toBe(true);
});

test('rejects unsupported, damaged and extremely narrow images', async () => {
    await expect(prepareImage(new Uint8Array(0))).rejects.toThrow();
    await expect(prepareImage(Buffer.from('GIF89a not an image'))).rejects.toThrow('PNG or JPEG');
    await expect(prepareImage(jpeg(1000, 800).subarray(0, 400))).rejects.toThrow();
    await expect(prepareImage(jpeg(2000, 200))).rejects.toThrow('elongated');
});

test('stops reading streams larger than 16 MiB', async () => {
    async function* stream() {
        for (let index = 0; index < 17; index++) yield new Uint8Array(1024 * 1024);
    }
    await expect(readImage(stream())).rejects.toThrow('16 MiB');
    async function* small() {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
    }
    expect([...await readImage(small())]).toEqual([1, 2, 3]);
});
