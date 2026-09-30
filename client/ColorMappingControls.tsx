import { useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { ChannelMixerParameters, GradientMapParameters, MixerRow } from './api';
import './color-mapping.css';

export const MIXER_DEFAULT: ChannelMixerParameters = { monochrome: false, red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [21.26, 71.52, 7.22, 0] };
export const GRADIENT_MAP_DEFAULT: GradientMapParameters = { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false };
export const mappingLabel = (kind: string) => kind === 'photo_filter' ? 'Photo Filter' : kind === 'hue_saturation' ? 'Hue / Saturation' : kind === 'selective_color' ? 'Selective Color' : kind === 'channel_mixer' ? 'Channel Mixer' : kind === 'gradient_map' ? 'Gradient Map' : kind === 'color_balance' ? 'Color Balance' : kind === 'black_white' ? 'Black & White' : kind;
export function validColorMapping(kind: string, parameters: unknown) {
  if (!parameters || typeof parameters !== 'object') return false;
  if (kind === 'channel_mixer') {
    const p = parameters as ChannelMixerParameters;
    return typeof p.monochrome === 'boolean' && (['red', 'green', 'blue', 'gray'] as const).every(key => Array.isArray(p[key]) && p[key].length === 4 && p[key].every(value => Number.isFinite(value) && value >= -200 && value <= 200 && Math.round(value * 100) / 100 === value));
  }
  const p = parameters as GradientMapParameters;
  return typeof p.reverse === 'boolean' && Array.isArray(p.stops) && p.stops.length >= 2 && p.stops.length <= 16 && p.stops[0].offset === 0 && p.stops.at(-1)!.offset === 1 && p.stops.every((stop, index) => Number.isFinite(stop.offset) && stop.offset >= 0 && stop.offset <= 1 && /^#[0-9a-f]{6}$/i.test(stop.color) && (!index || stop.offset > p.stops[index - 1].offset));
}

export function ChannelMixerControl({ value, onChange }: { value: ChannelMixerParameters; onChange: (parameters: ChannelMixerParameters) => void }) {
  const [output, setOutput] = useState<'red' | 'green' | 'blue'>('red');
  const rowKey = value.monochrome ? 'gray' : output;
  const row = value[rowKey];
  const sum = row.slice(0, 3).reduce((total, coefficient) => total + coefficient, 0);
  return <div className="channel-mixer-controls">
    <label className="mapping-check"><input aria-label="Mixer monochrome" type="checkbox" checked={value.monochrome} onChange={event => onChange({ ...value, monochrome: event.target.checked })} />Monochrome</label>
    <label className="field-label">Output channel<select aria-label="Mixer output channel" value={value.monochrome ? 'gray' : output} disabled={value.monochrome} onChange={event => setOutput(event.target.value as typeof output)}>{value.monochrome ? <option value="gray">Gray</option> : ['red', 'green', 'blue'].map(channel => <option key={channel} value={channel}>{channel[0].toUpperCase() + channel.slice(1)}</option>)}</select></label>
    <div className="mixer-coefficients">{['Red', 'Green', 'Blue', 'Constant'].map((label, index) => <label className="field-label" key={label}>{label}, %<input aria-label={`Mixer ${label.toLowerCase()} coefficient`} type="number" min="-200" max="200" step="0.01" value={row[index]} onChange={event => onChange({ ...value, [rowKey]: row.map((entry, i) => i === index ? Number(event.target.value) : entry) as MixerRow })} /></label>)}</div>
    <div className="mixer-row-summary"><span>Channel total <strong>{Number.isFinite(sum) ? Number(sum.toFixed(2)) : '—'}%</strong></span><button className="button mini subtle" aria-label="Reset mixer output row" onClick={() => onChange({ ...value, [rowKey]: [...MIXER_DEFAULT[rowKey]] })}><RotateCcw size={11} />Reset row</button></div>
    <p className="property-hint">Contributions are not normalized. Constant adds a percentage of full brightness. Color and gray rows are retained when switching modes.</p>
  </div>;
}

export function GradientMapControl({ value, onChange }: { value: GradientMapParameters; onChange: (parameters: GradientMapParameters) => void }) {
  const add = () => {
    let at = 0;
    for (let i = 1; i < value.stops.length - 1; i++) if (value.stops[i + 1].offset - value.stops[i].offset > value.stops[at + 1].offset - value.stops[at].offset) at = i;
    const a = value.stops[at], b = value.stops[at + 1];
    const color = '#' + [1, 3, 5].map(index => Math.round((parseInt(a.color.slice(index, index + 2), 16) + parseInt(b.color.slice(index, index + 2), 16)) / 2).toString(16).padStart(2, '0')).join('');
    onChange({ ...value, stops: [...value.stops.slice(0, at + 1), { offset: (a.offset + b.offset) / 2, color }, ...value.stops.slice(at + 1)] });
  };
  const valid = validColorMapping('gradient_map', value);
  return <div className="gradient-map-controls">
    <div className="gradient-map-ramp" role="img" aria-label="Gradient Map color ramp, shadows to highlights" style={{ background: `linear-gradient(to ${value.reverse ? 'left' : 'right'}, ${value.stops.map(stop => `${stop.color} ${stop.offset * 100}%`).join(', ')})` }} />
    <div className="mapping-tone-labels"><span>Shadows</span><span>Highlights</span></div>
    <label className="mapping-check"><input aria-label="Reverse gradient map" type="checkbox" checked={value.reverse} onChange={event => onChange({ ...value, reverse: event.target.checked })} />Reverse colors</label>
    <ol className="gradient-map-stops" aria-label="Gradient Map color stops">{value.stops.map((stop, index) => <li key={index}>
      <label className="field-label">Color {index + 1}<input aria-label={`Gradient map stop ${index + 1} color`} type="color" value={stop.color} onChange={event => onChange({ ...value, stops: value.stops.map((item, i) => i === index ? { ...item, color: event.target.value } : item) })} /></label>
      <label className="field-label">Position, %<input aria-label={`Gradient map stop ${index + 1} position`} type="number" min="0" max="100" step="any" value={Number((stop.offset * 100).toPrecision(14))} disabled={index === 0 || index === value.stops.length - 1} onChange={event => onChange({ ...value, stops: value.stops.map((item, i) => i === index ? { ...item, offset: Number(event.target.value) / 100 } : item) })} /></label>
      <button className="icon-button" aria-label={`Delete gradient map stop ${index + 1}`} disabled={index === 0 || index === value.stops.length - 1} onClick={() => onChange({ ...value, stops: value.stops.filter((_, i) => i !== index) })}><Trash2 size={12} /></button>
    </li>)}</ol>
    <button className="button mini subtle" disabled={!valid || value.stops.length >= 16} onClick={add}><Plus size={12} />Add gradient map stop</button>
    <p className="property-hint">2–16 ordered colors map image brightness using native sRGB interpolation. Alpha is preserved; endpoints stay at 0% and 100%.</p>
  </div>;
}
