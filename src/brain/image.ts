import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import type { ImageAsset } from '../types';

// TypeSafe limits, see https://docs.typesafe.ai/images#limits. The API rejects images
// outside them instead of resizing, so they are prepared here.
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MIN_SIDE = 280;
const MAX_SIDE = 1568;
// Decoding holds four bytes per pixel in memory, which a Homey has little of to spare.
const MAX_SOURCE_MEGAPIXELS = 24;

// One image at a time, for the same reason.
let queue: Promise<void> = Promise.resolve();

/**
 * Reads an image stream into memory, refusing anything over the TypeSafe file limit.
 */
export async function readImage(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let size = 0;

    for await (const chunk of stream) {
        size += chunk.length;

        if (size > MAX_IMAGE_BYTES) {
            throw new Error('The image is larger than 16 MiB.');
        }

        chunks.push(chunk);
    }

    return Buffer.concat(chunks, size);
}

/**
 * Turns a PNG or JPEG file into a JPEG that TypeSafe accepts: upright, since the API
 * ignores EXIF orientation, and 280–1568 pixels per side.
 */
export function prepareImage(bytes: Uint8Array): Promise<ImageAsset> {
    const result = queue.then(() => convert(bytes));
    // Drop the result, so the queue does not keep the last image in memory.
    queue = result.then(() => undefined, () => undefined);

    return result;
}

function convert(bytes: Uint8Array): ImageAsset {
    const {pixels, orientation} = decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    const rotated = orientation >= 5;
    const [width, height] = targetSize(rotated ? pixels.height : pixels.width, rotated ? pixels.width : pixels.height);
    // Scale before rotating, so the rotation only touches the small image.
    const upright = orient(resize(pixels, rotated ? height : width, rotated ? width : height), orientation);
    const data = encodeJpeg({width, height, data: upright.data}, 90).data;

    return {format: 'jpg', data: new Uint8Array(data.buffer, data.byteOffset, data.length)};
}

/**
 * Returns the smallest scaling of the image that fits both the minimum and maximum side.
 */
function targetSize(width: number, height: number): [number, number] {
    const short = Math.min(width, height);
    const long = Math.max(width, height);

    if (long / short > MAX_SIDE / MIN_SIDE) {
        throw new Error('The image is too elongated. Its long side can be at most 5.6 times its short side.');
    }

    let scale = Math.min(1, MAX_SIDE / long);

    if (short * scale < MIN_SIDE) {
        scale = MIN_SIDE / short;
    }

    const clamp = (value: number) => Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(value * scale)));

    return [clamp(width), clamp(height)];
}

function decode(bytes: Buffer): {pixels: Pixels; orientation: number} {
    const png = bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47;
    const jpeg = bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

    if (!png && !jpeg) {
        throw new Error('Unsupported image. Use a PNG or JPEG image.');
    }

    // The PNG header holds the size; jpeg-js enforces the same limit itself.
    if (png && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > MAX_SOURCE_MEGAPIXELS * 1000000) {
        throw new Error('The image is larger than 24 megapixels.');
    }

    try {
        if (png) {
            const pixels = PNG.sync.read(bytes);
            flatten(pixels.data);

            return {pixels, orientation: 1};
        }

        const pixels = decodeJpeg(bytes, {useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_SOURCE_MEGAPIXELS});
        // jpeg-js keeps the EXIF block after 'Exif\0'; the TIFF data starts one padding byte later.
        const exif = (pixels as {exifBuffer?: Uint8Array}).exifBuffer;

        return {pixels, orientation: exif ? readOrientation(Buffer.from(exif.buffer, exif.byteOffset + 1, exif.length - 1)) : 1};
    } catch {
        throw new Error('The image could not be read. Use a PNG or JPEG image of at most 24 megapixels.');
    }
}

/**
 * Reads the orientation tag from the first IFD of an EXIF TIFF block. Anything unreadable
 * counts as upright.
 */
function readOrientation(tiff: Buffer): number {
    try {
        const little = tiff.toString('latin1', 0, 2) === 'II';
        const u16 = (at: number) => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
        const u32 = (at: number) => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
        const ifd = u32(4);
        const count = u16(ifd);

        for (let index = 0; index < count; index++) {
            const entry = ifd + 2 + index * 12;

            if (u16(entry) === 0x0112) {
                const value = u16(entry + 8);
                return value >= 1 && value <= 8 ? value : 1;
            }
        }
    } catch {
        // Out-of-range reads mean a damaged EXIF block.
    }

    return 1;
}

/**
 * Places transparent pixels on white, since JPEG has no transparency.
 */
function flatten(data: Uint8Array): void {
    for (let offset = 0; offset < data.length; offset += 4) {
        const alpha = data[offset + 3];

        for (let channel = 0; channel < 3; channel++) {
            data[offset + channel] = Math.round((data[offset + channel] * alpha + 255 * (255 - alpha)) / 255);
        }
    }
}

/**
 * Area-averaging resize, one axis at a time. Every target pixel is the mean of the source
 * pixels it covers, which avoids the aliasing of nearest-neighbor sampling when shrinking.
 */
function resize(source: Pixels, width: number, height: number): Pixels {
    return scaleAxis(scaleAxis(source, width, source.height, true), width, height, false);
}

function scaleAxis(source: Pixels, width: number, height: number, horizontal: boolean): Pixels {
    const weights = horizontal ? kernel(source.width, width) : kernel(source.height, height);
    const data = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const {index, weight} = weights[horizontal ? x : y];
            const target = (y * width + x) * 4;

            let r = 0, g = 0, b = 0;

            for (let k = 0; k < index.length; k++) {
                const at = (horizontal ? y * source.width + index[k] : index[k] * source.width + x) * 4;
                r += source.data[at] * weight[k];
                g += source.data[at + 1] * weight[k];
                b += source.data[at + 2] * weight[k];
            }

            data[target] = r + 0.5;
            data[target + 1] = g + 0.5;
            data[target + 2] = b + 0.5;
            data[target + 3] = 255;
        }
    }

    return {width, height, data};
}

function kernel(source: number, target: number): Weights[] {
    const scale = source / target;

    return Array.from({length: target}, (_, position) => {
        const start = position * scale;
        const end = Math.min(source, start + scale);
        const index: number[] = [];
        const weight: number[] = [];

        for (let pixel = Math.floor(start); pixel < Math.ceil(end); pixel++) {
            const covered = Math.min(end, pixel + 1) - Math.max(start, pixel);

            if (covered > 0) {
                index.push(pixel);
                weight.push(covered / (end - start));
            }
        }

        return {index, weight};
    });
}

/**
 * Applies an EXIF orientation to the pixels, so the image is upright without metadata.
 */
function orient(source: Pixels, orientation: number): Pixels {
    if (orientation === 1) return source;

    const {width: w, height: h} = source;
    const rotated = orientation >= 5;
    const width = rotated ? h : w;
    const height = rotated ? w : h;
    const data = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sx: number, sy: number;

            switch (orientation) {
                case 2: sx = w - 1 - x; sy = y; break;
                case 3: sx = w - 1 - x; sy = h - 1 - y; break;
                case 4: sx = x; sy = h - 1 - y; break;
                case 5: sx = y; sy = x; break;
                case 6: sx = y; sy = h - 1 - x; break;
                case 7: sx = w - 1 - y; sy = h - 1 - x; break;
                default: sx = w - 1 - y; sy = x; break;
            }

            data.set(source.data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * width + x) * 4);
        }
    }

    return {width, height, data};
}

type Pixels = {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array;
};

type Weights = {
    readonly index: number[];
    readonly weight: number[];
};
