import { sha256 } from '../db.ts';
import { isClaudeCli, type StepType } from '../../shared/types.ts';
import { HtmlRenderer, STAGE_H, STAGE_W, asciiToPng, extractAscii, extractHtml, extractSvg, svgToPng } from '../render.ts';
import { runClaude, subscriptionCost, type ClaudeCliOpts } from './claude.ts';
import { ProviderError, type StepAdapter, type StepRequest, type StepResult } from './types.ts';

/**
 * Code-drawn steps: a language model writes SVG / ASCII / HTML for the predecessor artifact, and it is rendered
 * locally into an image or a video. The editable step instruction is the creative direction; the FORMAT contract
 * below is fixed per step type so the output can always be rendered. The writer is either the local claude CLI
 * (`claude-cli/…`, subscription) or any OpenRouter chat model.
 */

const HTML_RULES = `The page must be ONE complete, self-contained HTML document that fills a ${STAGE_W}x${STAGE_H} window (100vw x 100vh, no scrollbars). There is NO network access: no CDNs, web fonts, images, or fetches. You may use HTML/CSS, inline SVG, <canvas> 2D, WebGL, or three.js: an import map is already provided, so use <script type="module"> with \`import * as THREE from 'three'\` (addons from 'three/addons/…'). Size the renderer to window.innerWidth/innerHeight.`;

export const FORMAT: Partial<Record<StepType, string>> = {
  text_to_svg: `Output format: ONE complete standalone SVG document with xmlns="http://www.w3.org/2000/svg" and viewBox="0 0 ${STAGE_W} ${STAGE_H}". No <script>, no <image>, no external references or web fonts (generic font families only). Output only the SVG code.`,
  image_to_svg: `Output format: ONE complete standalone SVG document with xmlns="http://www.w3.org/2000/svg" and a viewBox matching the image's aspect ratio. No <script>, no <image> (do not embed the photo), no external references or web fonts. Output only the SVG code.`,
  text_to_ascii: 'Output format: ONLY the ASCII art itself, at most 100 columns wide and 45 lines tall, printable ASCII characters only. No code fences, no title, no explanation.',
  text_to_code_image: `Output format: ${HTML_RULES} The finished scene must be fully drawn within 2 seconds of loading; set window.__ready = true once it is. Output only the HTML.`,
  text_to_code_video: `Output format: ${HTML_RULES} It is recorded as a video for 6 seconds starting as soon as it loads, so it must animate continuously from the first frame (motion, camera move, or both) and look good the whole time. Set window.__ready = true once the first frame is drawn. Output only the HTML.`,
};

const WRITER_SYSTEM = 'You are a creative coder and illustrator playing one turn of a game of telephone. Produce exactly the requested artwork as code, following the output format strictly. Return only the code.';

export type CodeArtOpts = { claude: ClaudeCliOpts; openrouter: StepAdapter; renderer: HtmlRenderer; videoSeconds?: number };

export class CodeArtAdapter implements StepAdapter {
  opts: CodeArtOpts;
  constructor(opts: CodeArtOpts) {
    this.opts = opts;
  }

  /** Ask the writer model for code. Returns the raw reply plus provider metadata for the attempt record. */
  private async write(req: StepRequest, prompt: string) {
    const image = req.input.kind === 'image' ? { bytes: req.input.bytes, mime: req.input.mime } : undefined;
    if (isClaudeCli(req.modelId)) {
      const r = await runClaude(this.opts.claude, { modelId: req.modelId, prompt: image ? prompt : `${prompt}\n\n---\n\n${(req.input as any).text}`, image, system: WRITER_SYSTEM, signal: req.signal });
      return { text: r.text, meta: { ...subscriptionCost(r), providerModel: r.model, providerName: 'claude-cli (subscription)', inferenceSec: r.durationMs != null ? Math.round(r.durationMs / 100) / 10 : null } };
    }
    // Any OpenRouter chat model: reuse its describe/retell path with the full prompt as the instruction.
    const r = await this.opts.openrouter.execute({ ...req, type: image ? 'image_to_text' : 'text_to_text', instruction: prompt });
    if (r.output.kind !== 'text') throw new ProviderError('empty_output', 'Writer model returned no text.');
    const { output: _o, requestSnapshot: _s, ...meta } = r;
    return { text: r.output.text, meta };
  }

  async execute(req: StepRequest): Promise<StepResult> {
    const format = FORMAT[req.type];
    if (!format) throw new ProviderError('unsupported', `The code-art adapter cannot run ${req.type}.`);
    const prompt = `${req.instruction.trim()}\n\n${format}`;
    const { text, meta } = await this.write(req, prompt);
    const snapshot = {
      via: isClaudeCli(req.modelId) ? 'claude -p' : 'openrouter', model: req.modelId, instruction: req.instruction, format,
      input: req.input.kind === 'image' ? { image_sha256: sha256(req.input.bytes) } : { text: (req.input as any).text },
    };
    let output: StepResult['output'];
    let warnings: string[] = [];
    switch (req.type) {
      case 'text_to_svg':
      case 'image_to_svg':
        output = { kind: 'image', bytes: await svgToPng(extractSvg(text)) };
        break;
      case 'text_to_ascii':
        output = { kind: 'image', bytes: await asciiToPng(extractAscii(text)) };
        break;
      case 'text_to_code_image': {
        const r = await this.opts.renderer.image(extractHtml(text), req.signal);
        output = { kind: 'image', bytes: r.png };
        warnings = r.errors;
        break;
      }
      default: {
        const r = await this.opts.renderer.video(extractHtml(text), this.opts.videoSeconds ?? 6, req.signal);
        output = { kind: 'video', bytes: r.mp4 };
        warnings = r.errors;
      }
    }
    return {
      output,
      ...meta,
      // The generated source is the most interesting part of a code step: keep it with the attempt.
      expandedPrompt: `${text}${warnings.length ? `\n\n<!-- render warnings:\n${warnings.slice(0, 10).join('\n')}\n-->` : ''}`,
      requestSnapshot: snapshot,
    };
  }
}
