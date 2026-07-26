import * as cheerio from 'cheerio';
import { SeoAudit } from '../../schemas/audit.schema';

export function parseSeo(html: string): SeoAudit {
  const $ = cheerio.load(html);

  const titleText = $('title').first().text().trim();
  const title = titleText.length > 0 ? titleText : null;

  const metaDesc =
    $('meta[name="description" i]').attr('content')?.trim() ||
    $('meta[name="Description" i]').attr('content')?.trim() ||
    null;

  const canonicalUrl = $('link[rel="canonical" i]').attr('href')?.trim() || null;

  const h1Elements = $('h1');
  const h1Count = h1Elements.length;
  const firstH1Text = h1Elements.first().text().trim();
  const firstH1 = firstH1Text.length > 0 ? firstH1Text : null;

  const metaRobots = $('meta[name="robots" i]').attr('content')?.trim() || null;

  return {
    title,
    metaDescription: metaDesc,
    canonicalUrl,
    h1Count,
    firstH1,
    metaRobots,
  };
}
