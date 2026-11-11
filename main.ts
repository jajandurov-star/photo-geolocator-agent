// photo-geolocator-01 — entry for @banjareren (make.fun).
//
// Strategy: vision first, statistics second.
//  1. Ask a vision model through the gateway, one call per photo
//     (claude-sonnet-5-5; if Anthropic answers 401, gpt-6-sol instead).
//     A probe on the first photo decides which vendor works; the choice
//     is a function of the recorded answers only, so a replay sends the
//     same calls.
//  2. Any photo the model cannot place gets the fallback: (57, 27).
//     That point is the haversine-optimal single guess over the kit's
//     75-photo practice pool (mean error 6,843 km per photo, so a
//     model-free trial still scores about 329,000 of 500,377).
//     Colour/texture features of the practice photos were tried as a
//     region classifier (leave-one-out); they never beat this single
//     prior on mean error, so the fallback stays a constant.
//  3. Every photo is always answered: an unanswered photo costs
//     20,015 km, the worst possible error.
//
// Runs as `node /bot/main.ts` on Node 22 (erasable TypeScript, standard
// library only). Deterministic: no wall clock, no unseeded randomness;
// the model calls run four at a time but the answers are posted in
// photo order, so what is posted never depends on which call came
// back first.

const ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const OPENAI_MODEL = 'gpt-6-sol';
const MAX_TOKENS = 1024;
const CONCURRENCY = 4;
const RETRIES = 3;
/** Retried with a fixed backoff: a provider's transient errors. A gateway refusal (4xx) is final. */
const RETRY_STATUSES = [408, 429, 500, 502, 503, 504, 529];
const PRIOR = { lat: 57, lon: 27 };

const PROMPT =
  'Look at this street-level photo and work out where on Earth it was taken. ' +
  'Use every visible clue: the language and script on signs, the side of the road traffic drives on, ' +
  'road markings and signs, license plates, vegetation and trees, architecture and building styles, ' +
  'the landscape, the sky and the light. Reason briefly about the clues, then give your best estimate ' +
  'as one line of JSON: {"lat": <degrees north>, "lon": <degrees east>, "confidence": <0 to 1>}. ' +
  'If you cannot tell the country, still give your best guess — never refuse, never leave the coordinates out.';

interface Photo {
  id: string;
  url: string;
  answered: boolean;
}

interface Guess {
  id: string;
  lat: number;
  lon: number;
}

type Vendor = 'anthropic' | 'openai' | 'none';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function need(name: string): string {
  const v = env(name);
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
}

const envUrl = need('MAKEFUN_ENV_URL').replace(/\/+$/, '');
const anthropicUrl = env('ANTHROPIC_BASE_URL')?.replace(/\/+$/, '');
const anthropicKey = env('ANTHROPIC_API_KEY');
const openaiUrl = env('OPENAI_BASE_URL')?.replace(/\/+$/, '');
const openaiKey = env('OPENAI_API_KEY');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isLat = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const isLon = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

/** The latitude and longitude an answer gives: its first JSON object with lat and lon, else its first two numbers in range. */
function coordinates(text: string): { lat: number; lon: number } | null {
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      const lat = o.lat ?? o.latitude;
      const lon = o.lon ?? o.lng ?? o.longitude;
      if (isLat(lat) && isLon(lon) && !(lat === 0 && lon === 0)) return { lat, lon };
    } catch {
      // Not JSON: the next one, or the numbers below.
    }
  }
  const nums = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  for (let i = 0; i + 1 < nums.length; i += 1) {
    if (isLat(nums[i]) && isLon(nums[i + 1]) && !(nums[i] === 0 && nums[i + 1] === 0)) {
      return { lat: nums[i]!, lon: nums[i + 1]! };
    }
  }
  return null;
}

interface CallOut {
  text: string | null;
  /** HTTP status of a final refusal (4xx, or 429 the gateway marked do-not-retry). */
  refusedStatus: number | null;
  /** True when the gateway says no model is behind it (no provider key pushed): not transient, never retry. */
  noModel: boolean;
}

/** One model call. Returns the model's text, or null text plus the refusal status when the gateway/provider refused it for good. */
async function callModel(vendor: 'anthropic' | 'openai', jpeg: Buffer): Promise<CallOut> {
  const b64 = jpeg.toString('base64');
  let url: string;
  let headers: Record<string, string>;
  let body: string;
  if (vendor === 'anthropic') {
    url = `${anthropicUrl}/v1/messages`;
    headers = { 'content-type': 'application/json', 'x-api-key': anthropicKey!, 'anthropic-version': '2023-06-01' };
    body = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });
  } else {
    url = `${openaiUrl}/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` };
    body = JSON.stringify({
      model: OPENAI_MODEL,
      max_completion_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });
  }
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      if (attempt < RETRIES) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      process.stderr.write(`geolocator: ${vendor} call failed to send: ${(err as Error).message}\n`);
      return { text: null, refusedStatus: null, noModel: false };
    }
    if (res.ok) {
      const msg = (await res.json()) as {
        content?: { type: string; text?: string }[];
        choices?: { message?: { content?: string } }[];
      };
      if (vendor === 'anthropic') {
        return {
          text: (msg.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n'),
          refusedStatus: null,
          noModel: false,
        };
      }
      return { text: msg.choices?.[0]?.message?.content ?? '', refusedStatus: null, noModel: false };
    }
    const text = await res.text();
    // The gateway reports "no model behind it" as an upstream error, not a
    // 401: it is final, and retrying it only burns the trial's request cap.
    if (/upstream_unreachable|provides no model/i.test(text)) {
      process.stderr.write(`geolocator: ${vendor} has no model behind it (no provider key pushed)\n`);
      return { text: null, refusedStatus: res.status, noModel: true };
    }
    if (RETRY_STATUSES.includes(res.status) && res.headers.get('x-should-retry') !== 'false' && attempt < RETRIES) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    process.stderr.write(`geolocator: ${vendor} call refused (HTTP ${res.status}): ${text.slice(0, 200)}\n`);
    return { text: null, refusedStatus: res.status, noModel: false };
  }
}

async function download(p: Photo): Promise<Buffer | null> {
  try {
    const res = await fetch(`${envUrl}${p.url}`);
    if (!res.ok) {
      process.stderr.write(`geolocator: ${p.id} download HTTP ${res.status}\n`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    process.stderr.write(`geolocator: ${p.id} download failed: ${(err as Error).message}\n`);
    return null;
  }
}

/**
 * Decide which vendor, if any, answers model calls, by trying the first
 * downloadable photo: Anthropic, then OpenAI, then none. The decision is
 * a function of the recorded answers only, so a replay makes the same one.
 */
async function probeVendor(photos: Photo[]): Promise<{ vendor: Vendor; probed: Map<string, Guess | null> }> {
  const probed = new Map<string, Guess | null>();
  for (const p of photos) {
    const jpeg = await download(p);
    if (jpeg === null) {
      probed.set(p.id, null);
      continue;
    }
    if (anthropicUrl !== undefined && anthropicKey !== undefined) {
      const out = await callModel('anthropic', jpeg);
      if (out.text !== null) {
        const c = coordinates(out.text);
        probed.set(p.id, c === null ? null : { id: p.id, lat: c.lat, lon: c.lon });
        return { vendor: 'anthropic', probed };
      }
      if (!out.noModel && out.refusedStatus !== 401 && out.refusedStatus !== 403) {
        // Not an auth/no-model refusal: the vendor works but this photo failed; keep it.
        probed.set(p.id, null);
        return { vendor: 'anthropic', probed };
      }
    }
    if (openaiUrl !== undefined && openaiKey !== undefined) {
      const out = await callModel('openai', jpeg);
      if (out.text !== null) {
        const c = coordinates(out.text);
        probed.set(p.id, c === null ? null : { id: p.id, lat: c.lat, lon: c.lon });
        return { vendor: 'openai', probed };
      }
      if (!out.noModel && out.refusedStatus !== 401 && out.refusedStatus !== 403) {
        probed.set(p.id, null);
        return { vendor: 'openai', probed };
      }
    }
    probed.set(p.id, null);
    return { vendor: 'none', probed };
  }
  return { vendor: 'none', probed };
}

async function main(): Promise<number> {
  const listed = (await (await fetch(`${envUrl}/photos`)).json()) as { photos: Photo[] };
  const photos = listed.photos.filter((p) => !p.answered);
  if (photos.length === 0) return 0;

  const { vendor, probed } = await probeVendor(photos);
  process.stderr.write(`geolocator: vendor=${vendor}, ${photos.length} photos\n`);

  const guesses: (Guess | null)[] = new Array(photos.length).fill(null);
  let modelPlaced = 0;
  let priorPlaced = 0;
  photos.forEach((p, i) => {
    const g = probed.get(p.id);
    if (g !== undefined) {
      if (g !== null) {
        guesses[i] = g;
        modelPlaced += 1;
      }
    }
  });

  const rest = photos.map((p, i) => ({ p, i })).filter(({ p }) => !probed.has(p.id));
  if (vendor === 'none') {
    for (const { p, i } of rest) {
      guesses[i] = { id: p.id, lat: PRIOR.lat, lon: PRIOR.lon };
      priorPlaced += 1;
    }
  } else {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < rest.length) {
        const { p, i } = rest[next]!;
        next += 1;
        const jpeg = await download(p);
        if (jpeg === null) {
          guesses[i] = { id: p.id, lat: PRIOR.lat, lon: PRIOR.lon };
          priorPlaced += 1;
          continue;
        }
        const out = await callModel(vendor, jpeg);
        if (out.text === null) {
          guesses[i] = { id: p.id, lat: PRIOR.lat, lon: PRIOR.lon };
          priorPlaced += 1;
          continue;
        }
        const c = coordinates(out.text);
        if (c === null) {
          process.stderr.write(`geolocator: no coordinates in the answer for ${p.id}\n`);
          guesses[i] = { id: p.id, lat: PRIOR.lat, lon: PRIOR.lon };
          priorPlaced += 1;
        } else {
          guesses[i] = { id: p.id, lat: c.lat, lon: c.lon };
          modelPlaced += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rest.length) }, () => worker()));
  }

  // Any probed photo the model could not place also gets the prior.
  photos.forEach((p, i) => {
    if (probed.has(p.id) && guesses[i] === null) {
      guesses[i] = { id: p.id, lat: PRIOR.lat, lon: PRIOR.lon };
      priorPlaced += 1;
    }
  });

  const answers = guesses.filter((g): g is Guess => g !== null);
  if (answers.length === 0) return 1;
  const body = JSON.stringify({ answers });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${envUrl}/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await res.text();
    process.stdout.write(`geolocator: ${answers.length} of ${photos.length} photos answered (model ${modelPlaced}, prior ${priorPlaced}): HTTP ${res.status} ${text}\n`);
    if (res.ok) return 0;
    await sleep(2000);
  }
  return 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  process.stderr.write(`geolocator: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
}
