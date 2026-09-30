import sharp from 'sharp';

/**
 * A raster picture as a high-quality JPEG, when that is much smaller.
 *
 * Image models answer with 2–4 MB PNGs, and a board or sheet embeds the
 * picture in an SVG as base64 text — a third larger again. The hosted API can
 * hand a browser about 4.3 MB per file, so an 8 MB board could be shown but
 * never downloaded ("too large to download here"). Quality 92 with full
 * colour resolution keeps fine lettering and swatches crisp and takes a
 * picture to about a sixth of its size.
 *
 * Left alone when it is already small, not a raster, or the JPEG is not
 * meaningfully smaller (a flat diagram can compress better as PNG).
 */
export async function compactImage<T extends { bytes: Buffer; mimeType: string }>(picture: T): Promise<T> {
  if (!picture.mimeType.startsWith('image/') || picture.mimeType.includes('svg')) return picture;
  if (picture.bytes.length < 700_000) return picture;
  try {
    const jpeg = await sharp(picture.bytes)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toBuffer();
    return jpeg.length < picture.bytes.length * 0.8 ? { ...picture, bytes: jpeg, mimeType: 'image/jpeg' } : picture;
  } catch (err) {
    console.warn('[image] could not compact a picture:', (err as Error).message);
    return picture;
  }
}
