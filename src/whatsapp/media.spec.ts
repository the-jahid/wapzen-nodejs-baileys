import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { smallerPhoto } from './media';

// The real image library on real pictures: what goes up to the model.

// Random pixels barely compress, so this is a photo that really is large.
function noisyJpeg(width: number, height: number) {
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('smallerPhoto', () => {
  it('resizes a large photo to what the model reads, keeping its shape', async () => {
    const photo = await noisyJpeg(3000, 1500);
    const smaller = await smallerPhoto(photo, 'image/jpeg; charset=binary');

    expect(smaller.length).toBeLessThan(photo.length);
    const { width, height, format } = await sharp(smaller).metadata();
    expect({ width, height, format }).toEqual({
      width: 2048,
      height: 1024,
      format: 'jpeg',
    });
  });

  it('turns a sideways phone photo the right way up', async () => {
    // Stored 3000 wide by 1500 tall, and marked as held on its side.
    const sideways = await sharp(await noisyJpeg(3000, 1500))
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer();
    const { width, height } = await sharp(
      await smallerPhoto(sideways, 'image/jpeg'),
    ).metadata();
    expect({ width, height }).toEqual({ width: 1024, height: 2048 });
  });

  it('leaves an ordinary WhatsApp photo exactly as it came', async () => {
    const photo = await noisyJpeg(200, 200);
    expect(photo.length).toBeLessThan(500 * 1024);
    expect(await smallerPhoto(photo, 'image/jpeg')).toBe(photo);
  });

  it('leaves other formats alone, since a JPEG would lose transparency', async () => {
    const big = Buffer.alloc(600 * 1024, 1);
    expect(await smallerPhoto(big, 'image/png')).toBe(big);
  });

  it('keeps the original when the picture can not be read', async () => {
    const broken = Buffer.alloc(600 * 1024, 7);
    expect(await smallerPhoto(broken, 'image/jpeg')).toBe(broken);
  });
});
