import sharp from 'sharp';
import { LOGO_ASPECT, LOGO_DATA_URI } from './brandLogo.js';
import { STUDIO_LETTERHEAD } from './studioTeam.js';

/**
 * Put the studio's own name on a sheet an image model drew.
 *
 * Asked for a professional plan, an image model fills the title block with a
 * firm it invented — "Luxe Design Group, 1234 Design Way, Austin TX" — and
 * a client-facing sheet must not carry someone else's letterhead. The model
 * is told to leave the title block bare; this adds the real one, in code: the
 * studio's logo and the address, phone and website from its letterhead,
 * beneath the picture. Drawn as SVG text over the embedded picture, so the
 * lettering is exact — a model cannot be trusted to spell an address.
 */
export async function brandSheet(picture: { bytes: Buffer; mimeType: string }): Promise<{ bytes: Buffer; mimeType: string }> {
  const meta = await sharp(picture.bytes).metadata();
  const w = meta.width ?? 1536;
  const h = meta.height ?? 1024;

  const band = Math.round(w * 0.085);
  const pad = Math.round(w * 0.025);
  const logoH = Math.round(band * 0.78);
  const logoW = Math.round(logoH / LOGO_ASPECT);
  const fs = Math.max(13, Math.round(w * 0.0115));
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    STUDIO_LETTERHEAD.name.toUpperCase(),
    STUDIO_LETTERHEAD.address.join(', '),
    `${STUDIO_LETTERHEAD.phone}  ·  ${STUDIO_LETTERHEAD.website}`,
  ];
  const right = w - pad;
  const top = h + (band - fs * 1.7 * lines.length) / 2 + fs;
  const text = lines
    .map((l, i) => {
      const heading = i === 0;
      return `<text x="${right}" y="${(top + i * fs * 1.7).toFixed(1)}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="${heading ? fs * 1.05 : fs}" ${
        heading ? 'font-weight="700" letter-spacing="2"' : ''
      } fill="${heading ? '#1a1a1a' : '#555555'}">${esc(l)}</text>`;
    })
    .join('');

  const href = `data:${picture.mimeType};base64,${picture.bytes.toString('base64')}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h + band}" width="${w}" height="${h + band}">` +
    `<rect width="${w}" height="${h + band}" fill="#ffffff"/>` +
    `<image href="${href}" xlink:href="${href}" x="0" y="0" width="${w}" height="${h}"/>` +
    `<line x1="0" y1="${h}" x2="${w}" y2="${h}" stroke="#1a1a1a" stroke-width="1.5"/>` +
    `<image href="${LOGO_DATA_URI}" xlink:href="${LOGO_DATA_URI}" x="${pad}" y="${h + (band - logoH) / 2}" width="${logoW}" height="${logoH}"><title>Janelle Interiors</title></image>` +
    text +
    `</svg>`;
  return { bytes: Buffer.from(svg, 'utf8'), mimeType: 'image/svg+xml' };
}
